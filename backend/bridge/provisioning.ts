import mysql from "mysql2/promise";

// Provisioning writes against the POCSTARS vendor database. This runs only on
// the POCSTARS host (inside the bridge), so the credentials never leave that
// machine.
//
// Two rules are enforced here rather than left to callers, because getting
// either wrong fails silently:
//
//  1. echat reloads its in-memory copy on a ~10s incremental sync keyed on the
//     row's update timestamps. A write that does not move Last_Update_Time is
//     never picked up - the database looks correct while the radio network
//     behaves as if nothing happened. Every statement below bumps them.
//  2. A dispatcher seat only sees a group when it has an active
//     tb_UserOfGroup row for it. Seats of one organization must therefore all
//     carry membership of every one of that organization's active groups, or
//     they stop being interchangeable and seat leasing breaks.

export type ProvisioningConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export class PocstarsProvisioning {
  private pool: mysql.Pool;

  constructor(config: ProvisioningConfig) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionLimit: 4,
      waitForConnections: true,
      timezone: "local",
    });
  }

  async close() {
    await this.pool.end().catch(() => {});
  }

  async ping() {
    const [rows]: any = await this.pool.query("SELECT 1 AS ok");
    return rows?.[0]?.ok === 1;
  }

  // Seats available to an organization, most recently renewed first. The
  // password column holds the value echat expects verbatim, so the bridge can
  // authenticate as any seat without a credential store.
  async listSeats(companyId: number) {
    const [rows]: any = await this.pool.query(
      `SELECT User_ID AS uid, User_Account AS account, User_Password AS password,
              User_ServiceEndTime AS serviceEndsAt
         FROM tb_User
        WHERE User_CompanyID = ?
          AND User_Type = 3
          AND User_Enable = 1
          AND IsActive = 1
          -- echat refuses a banned account with 账号被禁用 regardless of the
          -- other flags, so leasing one wastes the lease and hands the operator
          -- a confusing error.
          AND COALESCE(User_Banned, 0) = 0
          AND User_ServiceEndTime IS NOT NULL
          AND User_ServiceEndTime > NOW()
        ORDER BY User_ID`,
      [companyId],
    );
    return rows as Array<{ uid: number; account: string; password: string; serviceEndsAt: Date }>;
  }

  // Create a company on the radio network plus its dispatcher seats, mirroring
  // the shape of an existing working company. The seat passwords are generated
  // and never leave this method: echat authenticates with the stored hash
  // verbatim, so the bridge can sign in later without anyone keeping the
  // plaintext. Nothing outside this host ever sees a credential.
  async createCompany({ name, slug, seats, agentOrgId = 11, serviceEndsAt }: {
    name: string; slug: string; seats: number; agentOrgId?: number; serviceEndsAt: string;
  }) {
    const seatCount = Math.max(1, Math.min(50, Math.floor(seats)));
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      const [clash]: any = await connection.query(
        "SELECT Corg_ID FROM tb_ComOrg WHERE Corg_Name = ? AND IsActive = 1",
        [name],
      );
      if (clash.length) throw new Error(`The radio network already has a company named ${name}.`);

      const [company]: any = await connection.query(
        `INSERT INTO tb_ComOrg
           (Aorg_ID, Corg_Name, Corg_Parent, Corg_Type, IsComDispatch, IsControl,
            Dis_Size, IsActive, Creation_Time, Last_Update_Time)
         VALUES (?, ?, 0, 0, 0, 1, ?, 1, NOW(), NOW())`,
        [agentOrgId, name, seatCount],
      );
      const companyId = Number(company.insertId);
      if (!companyId) throw new Error("The radio network did not return a company id.");

      const realm = this.realmFor(slug);
      const created: Array<{ uid: number; account: string }> = [];
      for (let index = 1; index <= seatCount; index += 1) {
        const account = `dp${index}@${realm}.TSY`;
        const [existing]: any = await connection.query(
          "SELECT User_ID FROM tb_User WHERE User_Account = ?",
          [account],
        );
        if (existing.length) {
          throw new Error(`Dispatcher account ${account} already exists on the radio network.`);
        }
        const [seat]: any = await connection.query(
          `INSERT INTO tb_User
             (User_Account, User_Password, User_Name, User_CompanyID, User_AgentID,
              User_Type, User_AudioStatus, User_Enable, IsActive, User_Back,
              Parent_CompanyID, User_Banned, User_Encrypt, network_type, chargeType,
              User_GPSswitch, User_GPSfrequency, sort,
              User_CreateTime, User_UpdateTime, User_ServiceBeginTime, User_ServiceEndTime,
              Creation_Time, Last_Update_Time)
           VALUES (?, ?, ?, ?, ?, 3, 1, 1, 1, 1, ?, 0, 0, 1, 1, 1, 30, 99,
                   NOW(), NOW(), NOW(), ?, NOW(), NOW())`,
          [account, this.newSeatPasswordHash(), account, companyId, agentOrgId, companyId, serviceEndsAt],
        );
        created.push({ uid: Number(seat.insertId), account });
      }

      await connection.commit();
      return { companyId, seats: created };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  // echat compares against the stored value, so a random hash is a password
  // nobody knows and nobody needs to know.
  private newSeatPasswordHash() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  private realmFor(slug: string) {
    const cleaned = String(slug || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!cleaned) throw new Error("An organization slug is required to name dispatcher accounts.");
    return cleaned.slice(0, 12);
  }

  // An organization's vendor company id is not carried by the voice protocol,
  // so it is recovered from any group already claimed by that organization.
  async companyForGroup(groupId: number) {
    const [rows]: any = await this.pool.query(
      "SELECT Cg_ComID AS companyId FROM tb_ChatGroup WHERE Cg_ID = ?",
      [groupId],
    );
    return rows.length ? Number(rows[0].companyId) : null;
  }

  // Radios straight from the database. The voice protocol can only enumerate
  // radios via group membership on this install (QueryContacts is rejected), so
  // handsets that belong to the company but sit in no group are invisible to
  // it - 15 of EPAIL's 90 at the time of writing. This sees all of them.
  async listRadios(companyId: number) {
    const [rows]: any = await this.pool.query(
      `SELECT u.User_ID AS uid, u.User_Account AS account, u.User_Name AS name,
              u.User_Enable AS enabled, u.User_ServiceEndTime AS serviceEndsAt,
              COALESCE(
                (SELECT GROUP_CONCAT(m.UOG_Cgid)
                   FROM tb_UserOfGroup m
                   JOIN tb_ChatGroup g ON g.Cg_ID = m.UOG_Cgid
                  WHERE m.UOG_UserId = u.User_ID AND m.IsActive = 1 AND g.IsActive = 1),
                ''
              ) AS groupIds
         FROM tb_User u
        WHERE u.User_CompanyID = ? AND u.User_Type = 0 AND u.IsActive = 1
        ORDER BY u.User_ID`,
      [companyId],
    );
    return rows.map((row: any) => ({
      uid: Number(row.uid),
      account: row.account,
      name: row.name || row.account,
      enabled: Number(row.enabled) === 1,
      serviceEndsAt: row.serviceEndsAt,
      groupIds: String(row.groupIds || "").split(",").filter(Boolean).map(Number),
    }));
  }

  async listGroups(companyId: number) {
    const [rows]: any = await this.pool.query(
      `SELECT Cg_ID AS id, Cg_Name AS name, Cg_Type AS type
         FROM tb_ChatGroup
        WHERE Cg_ComID = ? AND IsActive = 1
        ORDER BY Cg_ID`,
      [companyId],
    );
    return rows as Array<{ id: number; name: string; type: number }>;
  }

  // Create a talk group for an organization and give every one of that
  // organization's seats membership of it, so any leased seat can carry it.
  async createChannel({ companyId, name }: { companyId: number; name: string }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      const [companies]: any = await connection.query(
        "SELECT Corg_ID FROM tb_ComOrg WHERE Corg_ID = ? AND IsActive = 1",
        [companyId],
      );
      if (!companies.length) throw new Error(`Unknown or inactive company ${companyId}.`);

      const [clash]: any = await connection.query(
        "SELECT Cg_ID FROM tb_ChatGroup WHERE Cg_ComID = ? AND Cg_Name = ? AND IsActive = 1",
        [companyId, name],
      );
      if (clash.length) throw new Error(`This organization already has a channel named ${name}.`);

      const [result]: any = await connection.query(
        `INSERT INTO tb_ChatGroup
           (Cg_Name, Cg_ComID, Cg_CreateTime, Cg_Creator, Cg_CreatorType, Cg_Type,
            Cg_Prior, Cg_Speech_Limit_Second, Cg_Remark, IsActive,
            Creation_Time, Last_Update_Time)
         VALUES (?, ?, NOW(), 0, 1, 1, 0, 60, 'Created by MOMAS', 1, NOW(), NOW())`,
        [name, companyId],
      );
      const groupId = Number(result.insertId);
      if (!groupId) throw new Error("The radio network did not return a channel id.");

      const seats = await this.seatIdsForCompany(connection, companyId);
      for (const seatId of seats) {
        await connection.query(
          `INSERT INTO tb_UserOfGroup
             (UOG_Cgid, UOG_UserId, UOG_Priority, createTime, IsActive, Creation_Time, Last_Update_Time, isDefault)
           VALUES (?, ?, 0, NOW(), 1, NOW(), NOW(), 0)`,
          [groupId, seatId],
        );
      }
      await this.touchUsers(connection, seats);

      await connection.commit();
      return { groupId, seatsJoined: seats.length };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async renameChannel({ groupId, companyId, name }: { groupId: number; companyId: number; name: string }) {
    const [result]: any = await this.pool.query(
      `UPDATE tb_ChatGroup
          SET Cg_Name = ?, Last_Update_Time = NOW()
        WHERE Cg_ID = ? AND Cg_ComID = ?`,
      [name, groupId, companyId],
    );
    if (!result.affectedRows) throw new Error("That channel does not belong to this organization.");
    return { groupId };
  }

  // Retire rather than delete: the vendor keeps recordings and SOS history
  // pointing at the group id.
  async retireChannel({ groupId, companyId }: { groupId: number; companyId: number }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result]: any = await connection.query(
        `UPDATE tb_ChatGroup SET IsActive = 0, Last_Update_Time = NOW()
          WHERE Cg_ID = ? AND Cg_ComID = ?`,
        [groupId, companyId],
      );
      if (!result.affectedRows) throw new Error("That channel does not belong to this organization.");
      await connection.query(
        `UPDATE tb_UserOfGroup SET IsActive = 0, Last_Update_Time = NOW() WHERE UOG_Cgid = ?`,
        [groupId],
      );
      await connection.commit();
      return { groupId };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  // Put a radio on (or take it off) one of its organization's channels. The
  // radio and the channel must belong to the same company.
  async setRadioOnChannel({ companyId, groupId, radioUid, member }: {
    companyId: number; groupId: number; radioUid: number; member: boolean;
  }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [groups]: any = await connection.query(
        "SELECT Cg_ID FROM tb_ChatGroup WHERE Cg_ID = ? AND Cg_ComID = ? AND IsActive = 1",
        [groupId, companyId],
      );
      if (!groups.length) throw new Error("That channel does not belong to this organization.");
      const [radios]: any = await connection.query(
        "SELECT User_ID FROM tb_User WHERE User_ID = ? AND User_CompanyID = ? AND User_Type = 0",
        [radioUid, companyId],
      );
      if (!radios.length) throw new Error("That radio does not belong to this organization.");

      const [existing]: any = await connection.query(
        "SELECT UOG_ID FROM tb_UserOfGroup WHERE UOG_Cgid = ? AND UOG_UserId = ?",
        [groupId, radioUid],
      );
      if (existing.length) {
        await connection.query(
          "UPDATE tb_UserOfGroup SET IsActive = ?, Last_Update_Time = NOW() WHERE UOG_ID = ?",
          [member ? 1 : 0, existing[0].UOG_ID],
        );
      } else if (member) {
        await connection.query(
          `INSERT INTO tb_UserOfGroup
             (UOG_Cgid, UOG_UserId, UOG_Priority, createTime, IsActive, Creation_Time, Last_Update_Time, isDefault)
           VALUES (?, ?, 0, NOW(), 1, NOW(), NOW(), 0)`,
          [groupId, radioUid],
        );
      }
      await this.touchUsers(connection, [radioUid]);
      await connection.commit();
      return { groupId, radioUid, member };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  // Extend a seat's service window. This is the "recharge" the vendor console
  // charges for; with the database in our hands it is one column.
  async renewSeat({ uid, until }: { uid: number; until: string }) {
    const [result]: any = await this.pool.query(
      `UPDATE tb_User
          SET User_ServiceEndTime = ?, IsActive = 1,
              User_UpdateTime = NOW(), Last_Update_Time = NOW()
        WHERE User_ID = ? AND User_Type = 3`,
      [until, uid],
    );
    if (!result.affectedRows) throw new Error("That dispatcher seat could not be found.");
    return { uid, until };
  }

  private async seatIdsForCompany(connection: mysql.PoolConnection, companyId: number) {
    const [rows]: any = await connection.query(
      `SELECT User_ID FROM tb_User
        WHERE User_CompanyID = ? AND User_Type = 3 AND User_Enable = 1 AND IsActive = 1`,
      [companyId],
    );
    return rows.map((row: any) => Number(row.User_ID));
  }

  private async touchUsers(connection: mysql.PoolConnection, uids: number[]) {
    if (!uids.length) return;
    await connection.query(
      `UPDATE tb_User SET User_UpdateTime = NOW(), Last_Update_Time = NOW()
        WHERE User_ID IN (?)`,
      [uids],
    );
  }
}
