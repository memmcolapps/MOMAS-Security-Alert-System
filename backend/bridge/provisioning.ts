import mysql from "mysql2/promise";
import { MAX_CARD_YEARS, cardServiceWindow, day, manualServiceWindow } from "./licences";

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

  // Seats MOMAS holds for itself rather than for an operator. echat allows one
  // login per account and evicts the older session, so a seat that a background
  // watcher keeps signed in must never also be handed out for audio - the lease
  // would kill the watcher and the watcher's reconnect would kill the call.
  // The marker is the account name, because it is the one field the bridge can
  // read without another column the vendor schema does not have.
  static readonly RESERVED_ACCOUNT_PREFIX = "momas-";
  static readonly PRESENCE_DISPLAY_NAME = "tk4849";

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
          AND User_Account NOT LIKE CONCAT(?, '%')
          -- echat refuses a banned account with 账号被禁用 regardless of the
          -- other flags, so leasing one wastes the lease and hands the operator
          -- a confusing error.
          AND COALESCE(User_Banned, 0) = 0
          AND User_ServiceEndTime IS NOT NULL
          AND User_ServiceEndTime > NOW()
        ORDER BY User_ID`,
      [companyId, PocstarsProvisioning.RESERVED_ACCOUNT_PREFIX],
    );
    return rows as Array<{
      uid: number;
      account: string;
      password: string;
      serviceEndsAt: Date;
    }>;
  }

  // The seat the presence watcher signs in on, created on first use. It is a
  // normal dispatcher account in every respect except its name, which keeps it
  // out of listSeats and therefore out of every audio lease.
  async ensurePresenceSeat(companyId: number) {
    const account = `${PocstarsProvisioning.RESERVED_ACCOUNT_PREFIX}presence@${companyId}`;
    const [existing]: any = await this.pool.query(
      `SELECT User_ID AS uid, User_Account AS account, User_Password AS password,
              User_Name AS name,
              User_Enable AS enabled, User_Banned AS banned,
              User_ServiceEndTime AS serviceEndsAt
         FROM tb_User
        WHERE User_CompanyID = ? AND User_Account = ? AND IsActive = 1
        LIMIT 1`,
      [companyId, account],
    );
    if (existing.length) {
      const seat = existing[0];
      // Bring existing watcher names up to date without changing their login
      // or membership. Timestamp bumps make the radio server publish the name.
      if (seat.name !== PocstarsProvisioning.PRESENCE_DISPLAY_NAME) {
        await this.pool.query(
          `UPDATE tb_User
              SET User_Name = ?, User_UpdateTime = NOW(), Last_Update_Time = NOW()
            WHERE User_ID = ?`,
          [PocstarsProvisioning.PRESENCE_DISPLAY_NAME, seat.uid],
        );
      }
      // Only write when the seat actually needs it. Bumping the timestamps is
      // not free: echat's sync is incremental over a changed-since window, so
      // an unconditional write here made it reload these rows and push
      // Reconfigured and UsersChanged to every watcher on every cycle - thirty
      // rows every five minutes, all of it noise in the log people read when
      // the radio network is being diagnosed.
      const expiresSoon = !seat.serviceEndsAt
        || new Date(seat.serviceEndsAt).getTime() < Date.now() + 30 * 86400 * 1000;
      if (expiresSoon || Number(seat.enabled) !== 1 || Number(seat.banned) !== 0) {
        await this.pool.query(
          `UPDATE tb_User
              SET User_ServiceEndTime = ?, User_Enable = 1, User_Banned = 0,
                  User_UpdateTime = NOW(), Last_Update_Time = NOW()
            WHERE User_ID = ?`,
          ["2035-01-01 00:00:00", seat.uid],
        );
      }
      return seat as { uid: number; account: string; password: string };
    }

    // An inactive seat means the organization switched its watcher off. Making
    // a second account with the same name would undo that behind its back.
    const [switchedOff]: any = await this.pool.query(
      "SELECT User_ID FROM tb_User WHERE User_CompanyID = ? AND User_Account = ? AND IsActive = 0 LIMIT 1",
      [companyId, account],
    );
    if (switchedOff.length) {
      throw new Error(`The presence watcher for company ${companyId} is switched off.`);
    }

    const password = this.newSeatPasswordHash();
    const [result]: any = await this.pool.query(
      `INSERT INTO tb_User
         (User_Account, User_Password, User_Name, User_CompanyID, User_Type,
          User_Enable, User_Banned, IsActive, User_AudioStatus,
          User_CreateTime, User_UpdateTime, User_ServiceBeginTime,
          User_ServiceEndTime, Creation_Time, Last_Update_Time, sort)
       VALUES (?, ?, ?, ?, 3, 1, 0, 1, 1,
               NOW(), NOW(), NOW(), ?, NOW(), NOW(), 99)`,
      [account, password, PocstarsProvisioning.PRESENCE_DISPLAY_NAME, companyId, "2035-01-01 00:00:00"],
    );
    const uid = Number(result.insertId);
    if (!uid) throw new Error("The radio network did not return a seat id.");

    // A seat only hears a channel it belongs to, and presence is reported for
    // the members of the channels the account can see.
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [groups]: any = await connection.query(
        "SELECT Cg_ID FROM tb_ChatGroup WHERE Cg_ComID = ? AND IsActive = 1",
        [companyId],
      );
      for (const group of groups) {
        await connection.query(
          `INSERT INTO tb_UserOfGroup
             (UOG_Cgid, UOG_UserId, UOG_Priority, createTime, IsActive,
              Creation_Time, Last_Update_Time, isDefault)
           VALUES (?, ?, 0, NOW(), 1, NOW(), NOW(), 0)`,
          [group.Cg_ID, uid],
        );
      }
      await this.touchUsers(connection, [uid]);
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }

    return { uid, account, password };
  }

  // Takes the company's tk4849 presence seat out of every one of its channels,
  // or puts it back in all of them. Out means it no longer shows in any member
  // list, on handsets or consoles; MOMAS switches it out when an organization
  // relies on handset heartbeats alone.
  //
  // Deactivating the membership rows alone is not enough: echat drops them from
  // its membership table but keeps listing the seat in each channel's live
  // member list (checked 4 Nov 2026). What does clear those lists is the account
  // itself going inactive, so off deactivates both, and on reactivates both.
  // Nothing is deleted, and the timestamp bumps are what make echat's
  // incremental sync pick the change up.
  async setPresenceSeatMembership({
    companyId,
    member,
  }: {
    companyId: number;
    member: boolean;
  }) {
    const account = `${PocstarsProvisioning.RESERVED_ACCOUNT_PREFIX}presence@${companyId}`;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // An inactive seat is one this switched off, so it is looked up either way.
      const [seats]: any = await connection.query(
        `SELECT User_ID, IsActive FROM tb_User
          WHERE User_CompanyID = ? AND User_Account = ?
          ORDER BY IsActive DESC, User_ID DESC LIMIT 1`,
        [companyId, account],
      );
      // No seat yet: nothing to take out, and the watcher creates it already
      // in every channel the first time it starts.
      if (!seats.length) {
        await connection.commit();
        return { seat: null, member, channelsChanged: 0 };
      }
      const uid = Number(seats[0].User_ID);
      const seatActive = Number(seats[0].IsActive) === 1;
      let channelsChanged = 0;
      if (!member) {
        const [result]: any = await connection.query(
          `UPDATE tb_UserOfGroup SET IsActive = 0, Last_Update_Time = NOW()
            WHERE UOG_UserId = ? AND IsActive = 1`,
          [uid],
        );
        channelsChanged = Number(result.affectedRows || 0);
        if (seatActive) {
          await connection.query(
            `UPDATE tb_User SET IsActive = 0, User_UpdateTime = NOW(), Last_Update_Time = NOW()
              WHERE User_ID = ?`,
            [uid],
          );
        }
      } else {
        if (!seatActive) {
          await connection.query(
            `UPDATE tb_User SET IsActive = 1, User_UpdateTime = NOW(), Last_Update_Time = NOW()
              WHERE User_ID = ?`,
            [uid],
          );
        }
        const [groups]: any = await connection.query(
          "SELECT Cg_ID FROM tb_ChatGroup WHERE Cg_ComID = ? AND IsActive = 1",
          [companyId],
        );
        const [rows]: any = await connection.query(
          "SELECT UOG_ID, UOG_Cgid, IsActive FROM tb_UserOfGroup WHERE UOG_UserId = ?",
          [uid],
        );
        const byGroup = new Map<number, any>(rows.map((row: any) => [Number(row.UOG_Cgid), row]));
        for (const group of groups) {
          const row = byGroup.get(Number(group.Cg_ID));
          if (row && Number(row.IsActive) === 1) continue;
          if (row) {
            await connection.query(
              "UPDATE tb_UserOfGroup SET IsActive = 1, Last_Update_Time = NOW() WHERE UOG_ID = ?",
              [row.UOG_ID],
            );
          } else {
            await connection.query(
              `INSERT INTO tb_UserOfGroup
                 (UOG_Cgid, UOG_UserId, UOG_Priority, createTime, IsActive, Creation_Time, Last_Update_Time, isDefault)
               VALUES (?, ?, 0, NOW(), 1, NOW(), NOW(), 0)`,
              [group.Cg_ID, uid],
            );
          }
          channelsChanged += 1;
        }
      }
      // The account change above already bumps the seat; touch it only when
      // the channels moved on their own.
      if (channelsChanged && seatActive === member) await this.touchUsers(connection, [uid]);
      await connection.commit();
      return { seat: uid, member, channelsChanged };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  // Create a company on the radio network plus its dispatcher seats, mirroring
  // the shape of an existing working company. The seat passwords are generated
  // and never leave this method: echat authenticates with the stored hash
  // verbatim, so the bridge can sign in later without anyone keeping the
  // plaintext. Nothing outside this host ever sees a credential.
  async createCompany({
    name,
    slug,
    seats,
    agentOrgId = 11,
    serviceEndsAt,
  }: {
    name: string;
    slug: string;
    seats: number;
    agentOrgId?: number;
    serviceEndsAt: string;
  }) {
    const seatCount = Math.max(1, Math.min(50, Math.floor(seats)));
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      const [clash]: any = await connection.query(
        "SELECT Corg_ID FROM tb_ComOrg WHERE Corg_Name = ? AND IsActive = 1",
        [name],
      );
      if (clash.length)
        throw new Error(
          `The radio network already has a company named ${name}.`,
        );

      const [company]: any = await connection.query(
        `INSERT INTO tb_ComOrg
           (Aorg_ID, Corg_Name, Corg_Parent, Corg_Type, IsComDispatch, IsControl,
            Dis_Size, IsActive, Creation_Time, Last_Update_Time)
         VALUES (?, ?, 0, 0, 0, 1, ?, 1, NOW(), NOW())`,
        [agentOrgId, name, seatCount],
      );
      const companyId = Number(company.insertId);
      if (!companyId)
        throw new Error("The radio network did not return a company id.");

      const realm = this.realmFor(slug);
      const created: Array<{ uid: number; account: string }> = [];
      for (let index = 1; index <= seatCount; index += 1) {
        const account = `dp${index}@${realm}.TSY`;
        const [existing]: any = await connection.query(
          "SELECT User_ID FROM tb_User WHERE User_Account = ?",
          [account],
        );
        if (existing.length) {
          throw new Error(
            `Dispatcher account ${account} already exists on the radio network.`,
          );
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
          [
            account,
            this.newSeatPasswordHash(),
            account,
            companyId,
            agentOrgId,
            companyId,
            serviceEndsAt,
          ],
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

  // Extra dispatcher seats for a company that already exists. This is the only
  // write MOMAS makes into a company it did not create, and it happens exactly
  // once per organization, at promotion - the moment somebody decided we
  // operate them. Most companies on this install were sold a single seat, and a
  // single seat goes deaf to its own channel for the duration of any private
  // call, so a control room MOMAS runs needs more than the vendor left behind.
  async addSeats({
    companyId,
    count,
    slug,
    serviceEndsAt,
  }: {
    companyId: number;
    count: number;
    slug?: string;
    serviceEndsAt: string;
  }) {
    const wanted = Math.max(1, Math.min(50, Math.floor(count)));
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      const [companies]: any = await connection.query(
        "SELECT Corg_ID, Corg_Name, Aorg_ID, Dis_Size FROM tb_ComOrg WHERE Corg_ID = ? AND IsActive = 1 FOR UPDATE",
        [companyId],
      );
      if (!companies.length)
        throw new Error(`Unknown or inactive company ${companyId}.`);
      const company = companies[0];

      // Follow the company's own naming rather than inventing a second scheme:
      // a vendor-created company's seats are already dpN@THEIRREALM.TSY, and a
      // console operator reading two different realms in one company would have
      // no way to tell which accounts are theirs.
      const [seats]: any = await connection.query(
        "SELECT User_Account FROM tb_User WHERE User_CompanyID = ? AND User_Type = 3",
        [companyId],
      );
      const realm =
        this.realmFromSeats(
          seats.map((seat: any) => String(seat.User_Account)),
        ) || this.realmFor(slug || String(company.Corg_Name || ""));

      const taken = new Set(
        seats.map((seat: any) => String(seat.User_Account).toUpperCase()),
      );
      const created: Array<{ uid: number; account: string }> = [];
      let index = 1;
      while (created.length < wanted) {
        if (index > 200)
          throw new Error(
            `No free dispatcher account name for company ${companyId}.`,
          );
        const account = `dp${index}@${realm}.TSY`;
        index += 1;
        if (taken.has(account.toUpperCase())) continue;
        // The account name may also be held by another company on this shared
        // install, which the local set above cannot see.
        const [clash]: any = await connection.query(
          "SELECT User_ID FROM tb_User WHERE User_Account = ?",
          [account],
        );
        if (clash.length) continue;
        created.push({
          uid: await this.insertSeat(connection, {
            account,
            companyId,
            agentOrgId: company.Aorg_ID,
            serviceEndsAt,
          }),
          account,
        });
      }

      // The size cap is what the vendor console shows an administrator. Leaving
      // it behind would make the company look over-provisioned to anyone
      // reading the vendor UI. Last_Update_Time is explicit because nothing in
      // this schema sets it for us.
      await connection.query(
        "UPDATE tb_ComOrg SET Dis_Size = ?, Last_Update_Time = NOW() WHERE Corg_ID = ?",
        [
          Math.max(
            Number(company.Dis_Size || 0),
            seats.length + created.length,
          ),
          companyId,
        ],
      );

      await connection.commit();
      return { companyId, realm, seats: created };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  // dp3@EPAIL.TSY -> EPAIL. Only a name the company already uses counts, so a
  // stray account cannot rename the realm for every seat added afterwards.
  private realmFromSeats(accounts: string[]) {
    const counts = new Map<string, number>();
    for (const account of accounts) {
      const match = /^dp\d+@([A-Za-z0-9]+)\.TSY$/.exec(String(account).trim());
      if (!match) continue;
      const realm = match[1].toUpperCase();
      counts.set(realm, (counts.get(realm) || 0) + 1);
    }
    let best: string | null = null;
    for (const [realm, count] of counts) {
      if (!best || count > (counts.get(best) || 0)) best = realm;
    }
    return best;
  }

  private async insertSeat(
    connection: any,
    {
      account,
      companyId,
      agentOrgId,
      serviceEndsAt,
    }: {
      account: string;
      companyId: number;
      agentOrgId: number | null;
      serviceEndsAt: string;
    },
  ) {
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
      [
        account,
        this.newSeatPasswordHash(),
        account,
        companyId,
        agentOrgId,
        companyId,
        serviceEndsAt,
      ],
    );
    return Number(seat.insertId);
  }

  // echat compares against the stored value, so a random hash is a password
  // nobody knows and nobody needs to know.
  private newSeatPasswordHash() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }

  private realmFor(slug: string) {
    const cleaned = String(slug || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!cleaned)
      throw new Error(
        "An organization slug is required to name dispatcher accounts.",
      );
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
      groupIds: String(row.groupIds || "")
        .split(",")
        .filter(Boolean)
        .map(Number),
    }));
  }

  // Where a radio lives before anyone has been allocated it. A company with no
  // channels is the honest representation of unallocated hardware: the handset
  // exists and is inventoried, but it belongs to no talk group, so it can reach
  // nobody until a platform admin gives it to an organization.
  static readonly POOL_COMPANY_NAME = "MOMAS UNALLOCATED POOL";

  // Lookup only. The inventory sync needs the pool in its enumeration or
  // pooled radios go missing from the platform registry, but a read should
  // never bring a vendor company into existence as a side effect.
  async findPoolCompany() {
    const [rows]: any = await this.pool.query(
      "SELECT Corg_ID FROM tb_ComOrg WHERE Corg_Name = ? AND IsActive = 1 LIMIT 1",
      [PocstarsProvisioning.POOL_COMPANY_NAME],
    );
    return rows.length ? Number(rows[0].Corg_ID) : null;
  }

  async ensurePoolCompany() {
    const existingId = await this.findPoolCompany();
    if (existingId) return existingId;

    // No dispatcher seats: nothing should ever be able to talk to the pool.
    const [created]: any = await this.pool.query(
      `INSERT INTO tb_ComOrg
         (Aorg_ID, Corg_Name, Corg_Parent, Corg_Type, IsComDispatch, IsControl,
          Dis_Size, IsActive, Creation_Time, Last_Update_Time)
       VALUES (NULL, ?, 0, 0, 0, 1, 0, 1, NOW(), NOW())`,
      [PocstarsProvisioning.POOL_COMPANY_NAME],
    );
    const companyId = Number(created.insertId);
    if (!companyId)
      throw new Error("The radio network did not return a pool company id.");
    return companyId;
  }

  // Every company on this install. This is the only way MOMAS can learn about a
  // company nobody has told it about: every other handle it has - an
  // organization's recorded id, the owner of a claimed group - can only find a
  // company MOMAS already knew. The counts ride along because the caller sizes
  // an imported organization's seats from them, and asking per company would be
  // one round trip each over the tunnel for what a single join answers.
  async listCompanies() {
    const [rows]: any = await this.pool.query(
      `SELECT c.Corg_ID AS companyId, c.Corg_Name AS name,
              c.Corg_Parent AS parentId, c.Dis_Size AS seatCap,
              COUNT(DISTINCT CASE WHEN u.User_Type = 0 THEN u.User_ID END) AS radios,
              COUNT(DISTINCT CASE WHEN u.User_Type = 3 THEN u.User_ID END) AS seatRows,
              COUNT(DISTINCT CASE WHEN u.User_Type = 3
                                    AND u.User_Enable = 1
                                    AND COALESCE(u.User_Banned, 0) = 0
                                    AND u.User_Account NOT LIKE CONCAT(?, '%')
                                    AND u.User_ServiceEndTime IS NOT NULL
                                    AND u.User_ServiceEndTime > NOW()
                                   THEN u.User_ID END) AS seats
         FROM tb_ComOrg c
         LEFT JOIN tb_User u ON u.User_CompanyID = c.Corg_ID AND u.IsActive = 1
        WHERE c.IsActive = 1
        GROUP BY c.Corg_ID, c.Corg_Name, c.Corg_Parent, c.Dis_Size
        ORDER BY c.Corg_ID`,
      [PocstarsProvisioning.RESERVED_ACCOUNT_PREFIX],
    );
    return rows.map((row: any) => ({
      companyId: Number(row.companyId),
      name: String(row.name || `Company ${row.companyId}`),
      parentId: row.parentId === null ? null : Number(row.parentId),
      seatCap: Number(row.seatCap || 0),
      radios: Number(row.radios || 0),
      // Counted with listSeats' own predicate, not an approximation of it. The
      // difference is not cosmetic: on this install NCS has three dispatcher
      // rows and zero leasable seats, because one is MOMAS's reserved presence
      // account and the rest have expired service dates. Sizing an imported
      // organization from the row count would promise it consoles that echat
      // refuses to sign in.
      seats: Number(row.seats || 0),
      // Every dispatcher row, leasable or not. Kept beside the usable figure so
      // an operator can see that a company has seats which merely need renewing
      // rather than seats that do not exist.
      seatRows: Number(row.seatRows || 0),
      // The pool has to be enumerated - its radios are real handsets and would
      // be swept as stale if the sync stopped seeing them - but it must never
      // become an organization. An owner is precisely what a pooled radio does
      // not have.
      isPool: String(row.name || "") === PocstarsProvisioning.POOL_COMPANY_NAME,
    }));
  }

  // Move a handset to another organization. The uid does not change, which is
  // what makes this safe: MOMAS's device_id, the radio's location history, its
  // recordings and its terminal status all key off the uid and survive intact.
  // Only ownership and reachability move.
  async reassignRadio({
    uid,
    toCompanyId,
    channelIds,
    defaultChannelId,
  }: {
    uid: number;
    toCompanyId: number;
    channelIds: number[];
    defaultChannelId: number | null;
  }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      const [radios]: any = await connection.query(
        `SELECT User_ID, User_Account, User_Name, User_CompanyID
           FROM tb_User WHERE User_ID = ? AND User_Type = 0 AND IsActive = 1`,
        [uid],
      );
      if (!radios.length)
        throw new Error(
          `Radio ${uid} could not be found on the radio network.`,
        );
      const radio = radios[0];
      const fromCompanyId = Number(radio.User_CompanyID);

      const [companies]: any = await connection.query(
        "SELECT Corg_ID FROM tb_ComOrg WHERE Corg_ID = ? AND IsActive = 1",
        [toCompanyId],
      );
      if (!companies.length)
        throw new Error(`Unknown or inactive company ${toCompanyId}.`);

      const requested = [
        ...new Set(
          channelIds
            .map(Number)
            .filter((id) => Number.isSafeInteger(id) && id > 0),
        ),
      ];
      let channels: number[] = [];
      if (requested.length) {
        const [rows]: any = await connection.query(
          "SELECT Cg_ID FROM tb_ChatGroup WHERE Cg_ComID = ? AND IsActive = 1 AND Cg_ID IN (?)",
          [toCompanyId, requested],
        );
        channels = rows.map((row: any) => Number(row.Cg_ID));
        const rejected = requested.filter((id) => !channels.includes(id));
        if (rejected.length) {
          throw new Error(
            `Channel ${rejected[0]} does not belong to the receiving organization.`,
          );
        }
      }
      const bootChannel =
        defaultChannelId && channels.includes(Number(defaultChannelId))
          ? Number(defaultChannelId)
          : (channels[0] ?? null);

      // Leaving the old owner's channels is the part that must not be skipped.
      // The vendor does not enforce that a radio's channels belong to its own
      // company - there are already 22 memberships on this install that cross
      // it - so a stale row would leave the handset audible to its old tenant.
      const [stale]: any = await connection.query(
        `SELECT m.UOG_ID FROM tb_UserOfGroup m
           JOIN tb_ChatGroup g ON g.Cg_ID = m.UOG_Cgid
          WHERE m.UOG_UserId = ? AND m.IsActive = 1 AND g.Cg_ComID <> ?`,
        [uid, toCompanyId],
      );
      for (const row of stale) {
        await connection.query(
          "UPDATE tb_UserOfGroup SET IsActive = 0, Last_Update_Time = NOW() WHERE UOG_ID = ?",
          [row.UOG_ID],
        );
      }

      for (const channelId of channels) {
        const [existing]: any = await connection.query(
          "SELECT UOG_ID FROM tb_UserOfGroup WHERE UOG_Cgid = ? AND UOG_UserId = ?",
          [channelId, uid],
        );
        if (existing.length) {
          await connection.query(
            "UPDATE tb_UserOfGroup SET IsActive = 1, isDefault = ?, Last_Update_Time = NOW() WHERE UOG_ID = ?",
            [channelId === bootChannel ? 1 : 0, existing[0].UOG_ID],
          );
        } else {
          await connection.query(
            `INSERT INTO tb_UserOfGroup
               (UOG_Cgid, UOG_UserId, UOG_Priority, createTime, IsActive,
                Creation_Time, Last_Update_Time, isDefault)
             VALUES (?, ?, 0, NOW(), 1, NOW(), NOW(), ?)`,
            [channelId, uid, channelId === bootChannel ? 1 : 0],
          );
        }
      }

      await connection.query(
        `UPDATE tb_User
            SET User_CompanyID = ?, User_DefaultChatGroup = ?,
                User_UpdateTime = NOW(), Last_Update_Time = NOW()
          WHERE User_ID = ?`,
        [toCompanyId, bootChannel, uid],
      );

      await connection.commit();
      return {
        uid,
        account: radio.User_Account,
        name: radio.User_Name,
        fromCompanyId,
        toCompanyId,
        channels,
        defaultChannelId: bootChannel,
        leftChannels: stale.length,
      };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  // Every handset on this install signs in with the same stored value - it is
  // the column default, and all 78 of EPAIL's radios carry it. The handset is
  // identified by its IMEI, not by a secret, so there is nothing to generate.
  static readonly HANDSET_PASSWORD = "C4CA4238A0B923820DCC509A6F75849B";

  // Put a handset on the radio network. The uid is assigned by the database on
  // insert, which is why it cannot be supplied by the caller: MOMAS learns the
  // radio's identity from this call rather than the other way round.
  async createRadio({
    companyId,
    imei,
    name,
    channelIds,
    defaultChannelId,
    serviceEndsAt,
    gpsEnabled,
    gpsFrequency,
  }: {
    companyId: number;
    imei: string;
    name: string;
    channelIds: number[];
    defaultChannelId: number | null;
    serviceEndsAt: string;
    gpsEnabled: boolean;
    gpsFrequency: number;
  }) {
    const account = String(imei || "").trim();
    if (!account) throw new Error("The radio's IMEI is required.");
    if (!/^\d{10,20}$/.test(account)) {
      throw new Error("A radio's IMEI is the digits printed on the handset.");
    }
    if (!String(name || "").trim())
      throw new Error("A radio name is required.");

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      const [companies]: any = await connection.query(
        "SELECT Corg_ID FROM tb_ComOrg WHERE Corg_ID = ? AND IsActive = 1",
        [companyId],
      );
      if (!companies.length)
        throw new Error(`Unknown or inactive company ${companyId}.`);

      // An IMEI is one handset. The vendor schema does not enforce this, and a
      // duplicate would give two rows the same identity on the network.
      const [clash]: any = await connection.query(
        "SELECT User_ID, User_CompanyID FROM tb_User WHERE User_Account = ? AND IsActive = 1 LIMIT 1",
        [account],
      );
      if (clash.length) {
        throw new Error(
          Number(clash[0].User_CompanyID) === companyId
            ? `That IMEI is already registered as radio ${clash[0].User_ID}.`
            : "That IMEI is already registered to another organization on this network.",
        );
      }

      // A radio may only sit on its own organization's channels. Without this a
      // caller could put a handset into another tenant's talk group.
      const requested = [
        ...new Set(
          channelIds
            .map(Number)
            .filter((id) => Number.isSafeInteger(id) && id > 0),
        ),
      ];
      let channels: number[] = [];
      if (requested.length) {
        const [rows]: any = await connection.query(
          `SELECT Cg_ID FROM tb_ChatGroup
            WHERE Cg_ComID = ? AND IsActive = 1 AND Cg_ID IN (?)`,
          [companyId, requested],
        );
        channels = rows.map((row: any) => Number(row.Cg_ID));
        const rejected = requested.filter((id) => !channels.includes(id));
        if (rejected.length) {
          throw new Error(
            `Channel ${rejected[0]} does not belong to this organization.`,
          );
        }
      }
      const bootChannel =
        defaultChannelId && channels.includes(Number(defaultChannelId))
          ? Number(defaultChannelId)
          : (channels[0] ?? null);

      const [result]: any = await connection.query(
        `INSERT INTO tb_User
           (User_Account, User_Password, User_Name, User_CompanyID, User_Type,
            User_AudioStatus, User_Enable, IsActive, User_Back, Parent_CompanyID,
            User_Banned, User_Encrypt, network_type, chargeType, UserModel,
            YearCardType, User_GPSswitch, User_GPSfrequency, User_DefaultChatGroup,
            User_CreateTime, User_UpdateTime, User_ServiceBeginTime,
            User_ServiceEndTime, Creation_Time, Last_Update_Time, sort)
         VALUES (?, ?, ?, ?, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, ?, ?, ?,
                 NOW(), NOW(), NOW(), ?, NOW(), NOW(), 99)`,
        [
          account,
          PocstarsProvisioning.HANDSET_PASSWORD,
          String(name).trim(),
          companyId,
          gpsEnabled ? 1 : 0,
          Math.max(3, Number(gpsFrequency) || 3),
          bootChannel,
          serviceEndsAt,
        ],
      );
      const uid = Number(result.insertId);
      if (!uid) throw new Error("The radio network did not return a radio id.");

      for (const channelId of channels) {
        await connection.query(
          `INSERT INTO tb_UserOfGroup
             (UOG_Cgid, UOG_UserId, UOG_Priority, createTime, IsActive,
              Creation_Time, Last_Update_Time, isDefault)
           VALUES (?, ?, 0, NOW(), 1, NOW(), NOW(), ?)`,
          [channelId, uid, channelId === bootChannel ? 1 : 0],
        );
      }

      // Without this the row is correct and the network never notices it.
      await this.touchUsers(connection, [uid]);
      await connection.commit();
      return {
        uid,
        account,
        name: String(name).trim(),
        channels,
        defaultChannelId: bootChannel,
      };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async uidForAccount(account: string) {
    const [rows]: any = await this.pool.query(
      "SELECT User_ID AS uid FROM tb_User WHERE User_Account = ? LIMIT 1",
      [account],
    );
    return rows.length ? Number(rows[0].uid) : null;
  }

  // Open alarms, from any company on this install, that the SOS service never
  // addressed to the recipient. The service sends an alarm to whatever group
  // the radio is in when the button is pressed, so two kinds skip the
  // recipient and never show up in its /sos/mg/records page:
  //  - an EPAIL radio in a private call (the alarm goes to the call's
  //    temporary group), the case that hid the 2 Nov demo alarm;
  //  - every radio of every other company (the alarm goes to that company's
  //    own dispatchers). MOMAS manages radios for ~40 companies here, and
  //    until this read was widened none of their alarms reached it.
  // MOMAS files each alarm under the radio's own organization and drops the
  // ones from radios it does not manage. Rows come back in the same shape the
  // records page uses, so both feed one pipeline.
  async openSosAlarmsMissedBy(targetUid: number, sinceMs: number) {
    const [rows]: any = await this.pool.query(
      `SELECT m.sos_msg_id AS sosMsgId, m.sos_from_id AS sosFromId,
              m.sos_sender_name AS sosSendName, m.sos_cg_id AS sosCgId,
              m.sos_location_at AS sosLocationAt,
              m.sos_processor_id AS sosProcessorId,
              m.sos_processor_name AS sosProcessorName,
              m.sos_start_time_stamp AS sosStamp, m.sos_status AS sosStatus
         FROM tb_sos_alarm_message m
         JOIN tb_User sender ON sender.User_ID = m.sos_from_id
        WHERE m.sos_status = 0
          AND COALESCE(m.sos_valid, 0) = 0
          AND m.sos_start_time_stamp >= ?
          AND NOT EXISTS (
                SELECT 1 FROM tb_sos_alarm_message_record r
                 WHERE r.sos_msg_id = m.sos_msg_id AND r.sos_to_uid = ?)
        ORDER BY m.sos_msg_id DESC
        LIMIT 50`,
      [sinceMs, targetUid],
    );
    return rows.map((row: any) => ({
      ...row,
      sosMsgId: Number(row.sosMsgId),
      sosFromId: Number(row.sosFromId),
      sosCgId: row.sosCgId === null ? null : Number(row.sosCgId),
      sosStamp: Number(row.sosStamp),
      sosStatus: Number(row.sosStatus),
      // Marks the alarm for the console: it reached the radio network but was
      // routed past this recipient.
      sosMissedRecipient: true,
    }));
  }

  // The whole inventory read in one call: the same two queries listGroups and
  // listRadios run, but for every company at once. The inventory sync used to
  // ask company by company, and each ask is a round trip over the reverse
  // tunnel from the MOMAS server - about half a second on this site's link,
  // so forty companies cost twenty seconds of waiting every five minutes.
  async listInventory(companyIds: number[]) {
    const byCompany = new Map<number, { groups: any[]; radios: any[] }>(
      companyIds.map((companyId) => [companyId, { groups: [], radios: [] }]),
    );
    if (!companyIds.length) return byCompany;
    const [groupRows]: any = await this.pool.query(
      `SELECT Cg_ComID AS companyId, Cg_ID AS id, Cg_Name AS name, Cg_Type AS type
         FROM tb_ChatGroup
        WHERE Cg_ComID IN (?) AND IsActive = 1
        ORDER BY Cg_ID`,
      [companyIds],
    );
    const [radioRows]: any = await this.pool.query(
      `SELECT u.User_CompanyID AS companyId,
              u.User_ID AS uid, u.User_Account AS account, u.User_Name AS name,
              u.User_Enable AS enabled, u.User_ServiceEndTime AS serviceEndsAt,
              COALESCE(
                (SELECT GROUP_CONCAT(m.UOG_Cgid)
                   FROM tb_UserOfGroup m
                   JOIN tb_ChatGroup g ON g.Cg_ID = m.UOG_Cgid
                  WHERE m.UOG_UserId = u.User_ID AND m.IsActive = 1 AND g.IsActive = 1),
                ''
              ) AS groupIds
         FROM tb_User u
        WHERE u.User_CompanyID IN (?) AND u.User_Type = 0 AND u.IsActive = 1
        ORDER BY u.User_ID`,
      [companyIds],
    );
    for (const row of groupRows) {
      byCompany.get(Number(row.companyId))?.groups.push({ id: row.id, name: row.name, type: row.type });
    }
    for (const row of radioRows) {
      byCompany.get(Number(row.companyId))?.radios.push({
        uid: Number(row.uid),
        account: row.account,
        name: row.name || row.account,
        enabled: Number(row.enabled) === 1,
        serviceEndsAt: row.serviceEndsAt,
        groupIds: String(row.groupIds || "")
          .split(",")
          .filter(Boolean)
          .map(Number),
      });
    }
    return byCompany;
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
  async createChannel({
    companyId,
    name,
    includePresenceSeat = true,
  }: {
    companyId: number;
    name: string;
    // False while the organization's tk4849 watcher is switched off, so a new
    // channel does not bring it back into a member list.
    includePresenceSeat?: boolean;
  }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      const [companies]: any = await connection.query(
        "SELECT Corg_ID FROM tb_ComOrg WHERE Corg_ID = ? AND IsActive = 1",
        [companyId],
      );
      if (!companies.length)
        throw new Error(`Unknown or inactive company ${companyId}.`);

      const [clash]: any = await connection.query(
        "SELECT Cg_ID FROM tb_ChatGroup WHERE Cg_ComID = ? AND Cg_Name = ? AND IsActive = 1",
        [companyId, name],
      );
      if (clash.length)
        throw new Error(
          `This organization already has a channel named ${name}.`,
        );

      const [result]: any = await connection.query(
        `INSERT INTO tb_ChatGroup
           (Cg_Name, Cg_ComID, Cg_CreateTime, Cg_Creator, Cg_CreatorType, Cg_Type,
            Cg_Prior, Cg_Speech_Limit_Second, Cg_Remark, IsActive,
            Creation_Time, Last_Update_Time)
         VALUES (?, ?, NOW(), 0, 1, 1, 0, 60, 'Created by MOMAS', 1, NOW(), NOW())`,
        [name, companyId],
      );
      const groupId = Number(result.insertId);
      if (!groupId)
        throw new Error("The radio network did not return a channel id.");

      const seats = await this.seatIdsForCompany(
        connection,
        companyId,
        includePresenceSeat ? null : `${PocstarsProvisioning.RESERVED_ACCOUNT_PREFIX}presence@${companyId}`,
      );
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

  async renameChannel({
    groupId,
    companyId,
    name,
  }: {
    groupId: number;
    companyId: number;
    name: string;
  }) {
    const [result]: any = await this.pool.query(
      `UPDATE tb_ChatGroup
          SET Cg_Name = ?, Last_Update_Time = NOW()
        WHERE Cg_ID = ? AND Cg_ComID = ?`,
      [name, groupId, companyId],
    );
    if (!result.affectedRows)
      throw new Error("That channel does not belong to this organization.");
    return { groupId };
  }

  // The name the handset shows and every console lists. The timestamp bumps
  // are what make echat's incremental sync pick the new name up.
  async renameRadio({
    uid,
    companyId,
    name,
  }: {
    uid: number;
    companyId: number | null;
    name: string;
  }) {
    if (!name) throw new Error("A radio name is required.");
    const scoped = Number.isSafeInteger(companyId) && Number(companyId) > 0;
    const [result]: any = await this.pool.query(
      `UPDATE tb_User
          SET User_Name = ?, User_UpdateTime = NOW(), Last_Update_Time = NOW()
        WHERE User_ID = ? AND User_Type = 0 AND IsActive = 1
          ${scoped ? "AND User_CompanyID = ?" : ""}`,
      scoped ? [name, uid, companyId] : [name, uid],
    );
    if (!result.affectedRows)
      throw new Error(
        scoped
          ? "That radio does not belong to this organization on the radio network."
          : "That radio is not active on the radio network.",
      );
    return { uid, name };
  }

  // Retire rather than delete: the vendor keeps recordings and SOS history
  // pointing at the group id.
  async retireChannel({
    groupId,
    companyId,
  }: {
    groupId: number;
    companyId: number;
  }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result]: any = await connection.query(
        `UPDATE tb_ChatGroup SET IsActive = 0, Last_Update_Time = NOW()
          WHERE Cg_ID = ? AND Cg_ComID = ?`,
        [groupId, companyId],
      );
      if (!result.affectedRows)
        throw new Error("That channel does not belong to this organization.");
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

  // Retire rather than delete: the vendor keeps recordings and SOS history
  // pointing at the radio id. A retired handset is invisible to the inventory
  // (listRadios only sees IsActive = 1) and its IMEI is free to onboard again.
  async retireRadio({
    uid,
    companyId,
  }: {
    uid: number;
    companyId: number | null;
  }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows]: any = await connection.query(
        "SELECT User_ID, User_CompanyID, IsActive FROM tb_User WHERE User_ID = ? AND User_Type = 0 LIMIT 1",
        [uid],
      );
      const radio = rows[0];

      // Already gone from the network - retired here before, or retired in the
      // vendor console, or re-registered under a fresh uid. There is nothing to
      // retire and nothing for the inventory sync to re-import, so this is a
      // success, not a failure. Refusing here used to strand the MOMAS row: the
      // caller retires on the network first, so a radio the vendor had already
      // dropped could never be deleted from the console at all.
      if (!radio || Number(radio.IsActive) !== 1) {
        await connection.commit();
        return { uid, alreadyRetired: true, found: Boolean(radio) };
      }

      // Scope is checked against the row rather than folded into the UPDATE, so
      // a live radio belonging to someone else reports that plainly instead of
      // looking like a radio that is already gone.
      if (
        Number.isSafeInteger(companyId) &&
        Number(companyId) > 0 &&
        Number(radio.User_CompanyID) !== Number(companyId)
      ) {
        throw new Error(
          `Radio ${uid} belongs to another organization on the radio network.`,
        );
      }

      await connection.query(
        `UPDATE tb_User
            SET IsActive = 0, User_Enable = 0,
                User_UpdateTime = NOW(), Last_Update_Time = NOW()
          WHERE User_ID = ?`,
        [uid],
      );
      await connection.query(
        `UPDATE tb_UserOfGroup SET IsActive = 0, Last_Update_Time = NOW()
          WHERE UOG_UserId = ? AND IsActive = 1`,
        [uid],
      );
      await connection.commit();
      return { uid, alreadyRetired: false, found: true };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  // Put a radio on (or take it off) one of its organization's channels. The
  // radio and the channel must belong to the same company.
  async setRadioOnChannel({
    companyId,
    groupId,
    radioUid,
    member,
  }: {
    companyId: number;
    groupId: number;
    radioUid: number;
    member: boolean;
  }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [groups]: any = await connection.query(
        "SELECT Cg_ID FROM tb_ChatGroup WHERE Cg_ID = ? AND Cg_ComID = ? AND IsActive = 1",
        [groupId, companyId],
      );
      if (!groups.length)
        throw new Error("That channel does not belong to this organization.");
      const [radios]: any = await connection.query(
        "SELECT User_ID FROM tb_User WHERE User_ID = ? AND User_CompanyID = ? AND User_Type = 0",
        [radioUid, companyId],
      );
      if (!radios.length)
        throw new Error("That radio does not belong to this organization.");

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
    if (!result.affectedRows)
      throw new Error("That dispatcher seat could not be found.");
    return { uid, until };
  }

  // ── Annual cards ──────────────────────────────────────────────────────────
  // The vendor sells licence time as cards: one card is one year on one radio
  // or dispatcher. A company holds its own balance in Corg_YearCard; resellers
  // hold theirs in tb_AgentOrg and the vendor console still recharges from
  // those. MOMAS only ever spends the company's own cards.

  // A company's balance, every account's licence window, and recent
  // recharges, in one round trip's worth of queries.
  async getLicences(companyId: number) {
    const [[companies], [accounts], [history]]: any = await Promise.all([
      this.pool.query(
        `SELECT Corg_ID AS companyId, Corg_Name AS name,
                COALESCE(Corg_YearCard, 0) AS yearCards
           FROM tb_ComOrg WHERE Corg_ID = ? AND IsActive = 1`,
        [companyId],
      ),
      this.pool.query(
        `SELECT User_ID AS uid, User_Account AS account, User_Name AS name,
                User_Type AS type, User_Enable AS enabled, User_Banned AS banned,
                User_ServiceBeginTime AS serviceBeginsAt,
                User_ServiceEndTime AS serviceEndsAt, YearCardType AS cardState
           FROM tb_User
          WHERE User_CompanyID = ? AND IsActive = 1 AND User_Type IN (0, 3)
            AND User_Account NOT LIKE CONCAT(?, '%')
          ORDER BY User_Type DESC, User_ServiceEndTime, User_ID`,
        [companyId, PocstarsProvisioning.RESERVED_ACCOUNT_PREFIX],
      ),
      this.pool.query(
        `SELECT l.ID AS id, l.User_ID AS uid, u.User_Name AS name, u.User_Account AS account,
                l.CartType AS paidBy, l.CardNum AS cards, l.serviceTime AS serviceWindow,
                l.Content AS note, l.CreateTime AS createdAt
           FROM tb_UserLogDeposit l
           JOIN tb_User u ON u.User_ID = l.User_ID
          WHERE u.User_CompanyID = ?
          ORDER BY l.ID DESC
          LIMIT 50`,
        [companyId],
      ),
    ]);
    if (!companies.length) throw new Error("That company is not on the radio network.");
    return {
      companyId,
      name: companies[0].name,
      yearCards: Number(companies[0].yearCards),
      accounts: accounts.map((row: any) => ({
        uid: Number(row.uid),
        account: row.account,
        name: row.name || row.account,
        kind: Number(row.type) === 3 ? "dispatcher" : "radio",
        enabled: Number(row.enabled) === 1 && Number(row.banned || 0) === 0,
        serviceBeginsAt: row.serviceBeginsAt,
        serviceEndsAt: row.serviceEndsAt,
        // -1 never activated, 2 not yet in effect: the vendor treats both as
        // switched off whatever the expiry date says.
        activated: ![-1, 2].includes(Number(row.cardState)),
      })),
      history: history.map((row: any) => ({
        id: Number(row.id),
        uid: Number(row.uid),
        name: row.name || row.account,
        // CartType 1 is a reseller's card, 3 the company's own.
        paidBy: Number(row.paidBy) === 3 ? "company" : "reseller",
        cards: Number(row.cards || 0),
        serviceWindow: row.serviceWindow,
        note: row.note,
        createdAt: row.createdAt,
      })),
    };
  }

  // Add licence time to accounts of one company. With `years`, it costs one of
  // the company's cards per account per year and refuses when the balance is
  // short. With `until`, a platform owner sets the date directly and no card is
  // spent. Either way each account gets a row in the vendor's own recharge log,
  // so its console shows the same history.
  async rechargeLicences({
    companyId,
    uids,
    years,
    until,
    actor,
    reason,
  }: {
    companyId: number;
    uids: number[];
    years?: number;
    until?: Date;
    actor: string;
    reason?: string;
  }) {
    const ids = [...new Set(uids.map(Number))].filter((id) => Number.isSafeInteger(id) && id > 0);
    if (!ids.length || ids.length > 500) throw new Error("Pick between 1 and 500 accounts.");
    const byCard = until === undefined;
    if (byCard && !(Number.isSafeInteger(years) && years! >= 1 && years! <= MAX_CARD_YEARS)) {
      throw new Error(`Years must be a whole number from 1 to ${MAX_CARD_YEARS}.`);
    }

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // The vendor console spends the same balance; the row lock keeps the two
      // from both spending the last card.
      const [companies]: any = await connection.query(
        `SELECT Corg_Name AS name, COALESCE(Corg_YearCard, 0) AS yearCards
           FROM tb_ComOrg WHERE Corg_ID = ? AND IsActive = 1 FOR UPDATE`,
        [companyId],
      );
      if (!companies.length) throw new Error("That company is not on the radio network.");
      const company = companies[0];

      const [rows]: any = await connection.query(
        `SELECT User_ID AS uid, User_ServiceBeginTime AS begin, User_ServiceEndTime AS end
           FROM tb_User
          WHERE User_ID IN (?) AND User_CompanyID = ? AND IsActive = 1 AND User_Type IN (0, 3)
            AND User_Account NOT LIKE CONCAT(?, '%')
          FOR UPDATE`,
        [ids, companyId, PocstarsProvisioning.RESERVED_ACCOUNT_PREFIX],
      );
      if (rows.length !== ids.length) {
        throw new Error("Some of those accounts are not in this company any more. Reload and try again.");
      }

      const cost = byCard ? ids.length * years! : 0;
      if (cost > Number(company.yearCards)) {
        throw new Error(
          `This needs ${cost} card${cost === 1 ? "" : "s"} and the company has ${company.yearCards}.`,
        );
      }

      const now = new Date();
      const note = byCard
        ? `MOMAS: ${years} card${years === 1 ? "" : "s"} each, by ${actor}`
        : `MOMAS: date set by ${actor}${reason ? ` - ${reason}` : ""}`;
      const results = [];
      for (const row of rows) {
        const current = {
          begin: row.begin ? new Date(row.begin) : null,
          end: row.end ? new Date(row.end) : null,
        };
        const next = byCard
          ? cardServiceWindow({ ...current, years: years!, now })
          : manualServiceWindow({ ...current, until: until!, now });
        const live = next.end.getTime() > now.getTime();
        // YearCardType 0 is what the vendor's own renew writes. It is the flag
        // that turns a "not yet in effect" account on, so only set it when the
        // account should be working.
        await connection.query(
          `UPDATE tb_User
              SET User_ServiceBeginTime = ?, User_ServiceEndTime = ?,
                  ${live ? "YearCardType = 0," : ""}
                  User_ServiceUpDateTime = NOW(), User_UpdateTime = NOW(), Last_Update_Time = NOW()
            WHERE User_ID = ?`,
          [next.begin, next.end, row.uid],
        );
        await connection.query(
          `INSERT INTO tb_UserLogDeposit
             (Aorg_ID, Aorg_Name, UserIP, User_ID, CartType, CardNum, CreateTime, Content, serviceTime, payType)
           VALUES (?, ?, 'momas', ?, 3, ?, NOW(), ?, ?, 12)`,
          [companyId, company.name, row.uid, byCard ? years : 0, note.slice(0, 500), `${day(next.begin)}~${day(next.end)}`],
        );
        results.push({ uid: Number(row.uid), serviceEndsAt: next.end });
      }

      if (cost) {
        await connection.query(
          "UPDATE tb_ComOrg SET Corg_YearCard = Corg_YearCard - ?, Last_Update_Time = NOW() WHERE Corg_ID = ?",
          [cost, companyId],
        );
      }
      await connection.commit();
      return { companyId, cardsSpent: cost, yearCards: Number(company.yearCards) - cost, accounts: results };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  // Set a company's card balance outright. The vendor gets cards to a company
  // through its reseller tier; this is the platform owner doing the same by
  // hand, so it is a plain set rather than a transfer.
  async setYearCards({ companyId, yearCards }: { companyId: number; yearCards: number }) {
    if (!Number.isSafeInteger(yearCards) || yearCards < 0 || yearCards > 100_000) {
      throw new Error("Enter a card balance from 0 to 100000.");
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows]: any = await connection.query(
        "SELECT COALESCE(Corg_YearCard, 0) AS yearCards FROM tb_ComOrg WHERE Corg_ID = ? AND IsActive = 1 FOR UPDATE",
        [companyId],
      );
      if (!rows.length) throw new Error("That company is not on the radio network.");
      await connection.query(
        "UPDATE tb_ComOrg SET Corg_YearCard = ?, Last_Update_Time = NOW() WHERE Corg_ID = ?",
        [yearCards, companyId],
      );
      await connection.commit();
      return { companyId, previous: Number(rows[0].yearCards), yearCards };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  private async seatIdsForCompany(
    connection: mysql.PoolConnection,
    companyId: number,
    excludeAccount: string | null = null,
  ) {
    const [rows]: any = await connection.query(
      `SELECT User_ID FROM tb_User
        WHERE User_CompanyID = ? AND User_Type = 3 AND User_Enable = 1 AND IsActive = 1
          AND User_Account <> ?`,
      [companyId, excludeAccount ?? ""],
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
