# POCSTARS radio integration

Verified against the installed POCSTARS server on 28 July 2026.

## What is available

POCSTARS supports the operator workflows MOMAS needs:

- listen to one or more groups;
- push to talk in the current group;
- call one radio;
- create a temporary call with selected radios;
- interrupt/take the microphone as a dispatcher;
- send an audio broadcast;
- query and download stored PTT recordings.

Live voice is **not** exposed as a normal HTTP API on this installation. The
server-side web UI is hosted inside a Qt WebView and calls a native
`QWebChannel` object named `context`. That native object contains the PTT
client, audio device handling, codecs, floor control and voice-server session.

The HTTP APIs below are usable independently of that native client.

## Stored PTT recordings

The installed LBS service exposes recordings on port `9275`.

### Query recordings

```http
POST /speakRecord/queryList
Content-Type: application/x-www-form-urlencoded
```

Required fields:

| Field | Purpose |
| --- | --- |
| `pageIndex` | One-based page number |
| `pageSize` | Number of recordings per page |
| `uid` | Dispatcher/radio user whose permitted recordings are queried |

Optional fields:

| Field | Purpose |
| --- | --- |
| `groupName` | Filter by group name |
| `groupType` | Filter by POCSTARS group type |
| `callIdDate` | Date range formatted as `YYYY-MM-DD ~ YYYY-MM-DD` |
| `speakerUserName` | Filter by speaker |

Example:

```bash
curl --request POST \
  --data 'pageIndex=1&pageSize=25&uid=583' \
  http://POCSTARS_SERVER:9275/speakRecord/queryList
```

The standard response envelope contains:

```json
{
  "code": 200,
  "message": "success",
  "success": true,
  "data": {
    "pageCount": 1,
    "pageIndex": 1,
    "pageSize": 25,
    "speakRecordList": []
  }
}
```

Each recording can include:

- `Rc_ID`
- `Rc_ChatGroupID`
- `Rc_ChatGroupName`
- `Rc_GroupType`
- `Rc_SpeakerUserID`
- `Rc_SpeakerUserName`
- `Rc_SpeakStartTime`
- `Rc_SpeakTimeOfMilliSecond`
- `Rc_CodeFormat`
- `Rc_SavePath`

The endpoint was tested read-only on the installed server and returned a
recording for the configured MOMAS dispatcher UID.

### Download or stream a recording

The LBS controller advertises
`GET /speakRecord/downLoadFile?path={Rc_SavePath}`, but that endpoint is
misconfigured on this installation: it points at `/opt/AudioData` while the
files are stored under the recording host's `/data/marine/AudioData`.

The working source is the authenticated POCSTARS recording host already
configured as `RECORD_DOWN_URL` in the dispatcher application. MOMAS uses that
host through these settings:

```dotenv
POCSTARS_RECORDINGS_BASE=http://recordfile.epailnigeria.com
POCSTARS_RECORDINGS_USERNAME=...
POCSTARS_RECORDINGS_PASSWORD=...
```

The saved codec `101` files contain AMR frames without the normal AMR file
header. The MOMAS backend fetches the bytes, adds the header, transcodes the
short clip to MP3, and returns it through an authenticated playback URL. Raw
storage paths and POCSTARS credentials are never returned to the browser.

MOMAS endpoints:

```http
GET /api/pocstars/radio/recordings
GET /api/pocstars/radio/recordings/{playbackToken}/audio
```

The list is filtered against the radios visible in the authenticated
operator's organization/unit scope. The audio endpoint checks the same access
again before retrieving the clip.

## Text and file communication

The public media service at port `6871` supports direct text delivery to one
or more radio user IDs:

```http
POST /slmedia/api/v1/media/send
Content-Type: application/x-www-form-urlencoded
```

The installed dispatcher sends these fields:

| Field | Purpose |
| --- | --- |
| `from` | Dispatcher UID (`583` for this installation) |
| `from_name` | Sender label shown by POCSTARS |
| `to` | One radio UID or comma-separated radio UIDs |
| `to_name` | Corresponding display names |
| `msg` | Text body |
| `msg_descriptor` | Text description |
| `msg_type` | `1` for text |
| `source_flag` | `3` for dispatcher-to-user delivery |
| `token` | Legacy media API token field |

MOMAS exposes the scoped wrapper:

```http
POST /api/pocstars/radio/messages
Content-Type: application/json

{
  "device_id": "449",
  "message": "Report your status"
}
```

The backend verifies that the selected radio belongs to the authenticated
operator's organization/unit, limits text to the vendor's 200-byte maximum,
sends as the configured dispatcher, and writes an audit event without storing
the message body.

The newer media-session service on port `6874` also exposes:

```text
GET  /media/group/message/list
GET  /media/group/message/list/{groupId}
GET  /media/group/message/search
POST /media/group/message/send
POST /media/group/message/sendfile

GET  /media/console/message/list
GET  /media/console/message/broadcast/search
POST /media/console/message/broadcast/send
POST /media/console/message/report/send
POST /media/console/message/report/sendfile

POST   /media/session/add
POST   /media/session/update
DELETE /media/session/delete
GET    /media/session/list/{userId}
POST   /media/session/member/add
DELETE /media/session/member/delete
GET    /media/session/message/list
GET    /media/session/message/history/list
POST   /media/session/message/send
POST   /media/session/message/sendfile
```

These endpoints are for multimedia messages and chat sessions, not live PTT
audio.

## Native dispatcher contract

The installed dispatcher web application is version `v2.12.12`. It initializes
the native client as follows:

```text
Init_Config(profile, dispatchBootstrapAddress, protocolCode)
login(account, password, 3)
```

The configured profile is `TSS`, the protocol code is `101`, and the dispatch
bootstrap is UDP port `10600`. On this installation the resolved EChat control
service is `192.168.1.65:22055`, with the audio address and port supplied by
the current-group event.

### Identity, groups and members

```text
GetUid
GetName
GetCurrentUser
GetGroupList
GetGroupListExtern
GetGroupByGid
GetCurrentGroup
GetMemberList
GetMemberListRefresh
GetUser
GetUsers
GetOnlineStatus
```

### Live listening and PTT

```text
JoinGroup(gid)
LeaveGroup()
StartSpeak()
StopSpeak()
IsSpeaking(callback)
IsListening(callback)
GetSpeakingUsers(callback)
GetPlayingSoundUserMsg(callback)
```

### Multi-group monitoring

```text
StartWatchGroup(gid, callback)
StopWatchGroup(gid, callback)
GetWatchGroups
GetWatchGroupCount
AddWatchGroup(gids, 1, callback)
RmWatchGroup(gids, 1, callback)
```

### Private and temporary calls

```text
Call([uid])
Call([uid1, uid2, ...])
TempJoinGroup(gid, uids)
TempLeaveGroup(0, uids)
SendInvite(...)
SendResponseInvite(...)
```

`Call([uid])` starts a one-radio call. Passing multiple online UIDs creates a
temporary group call.

### Dispatcher controls

```text
ForceDispatch(uids)
Takemic(uids)
Audioenable(uids, enable)
SendAudioBroadcast(...)
SendTextBroadcast(...)
```

### Recording support in the native client

```text
EnableLocalRecord(enable, path)
PlayLocalRecord(path)
PlayRecordOnLine(...)
PlayRecordOnLineEx(...)
StartRecordAudio(...)
StopRecordAudio(...)
PlayAudioOnLine(...)
RecordTranscode(...)
```

## Component boundary

The installed services have distinct responsibilities:

| Component | Responsibility |
| --- | --- |
| Dispatch bootstrap (`UDP 10600`) | Finds the correct voice server for the dispatcher |
| Native Qt dispatcher client | Authentication, group state, audio, codecs, floor control and live PTT |
| EChat voice service | Proprietary live voice transport |
| LBS service (`9275`) | Location history and stored PTT recording access |
| Public media service (`6871`) | Direct text, files and legacy multimedia delivery |
| Media-session service (`6874`) | Session/group multimedia chat |
| SOS service (`6891`) | Alarm feed, acknowledge/start-response and resolve |
| RTC services | Video/full-duplex RTC features; not the installed group-PTT interface |

## MOMAS live bridge

MOMAS now implements the narrow dispatcher client it needs directly in the
backend. It uses the protobuf control messages and RTP/AMR-NB voice transport
already running in EChat; the browser never connects to a POCSTARS voice port.

```text
POCSTARS EChat (control + RTP/AMR-NB)
        |
MOMAS radio gateway
  - group/member permission checks
  - floor/PTT state
  - browser PCM to AMR-NB conversion
  - recording proxy
        |
Authenticated MOMAS WebSocket
        |
MOMAS operator UI
```

The first gateway release exposes:

- one private call to a selected, permitted radio;
- live incoming AMR-NB audio;
- press/release floor control and outgoing microphone audio;
- current speaker and PTT state;
- stored recording search/playback through the existing HTTP endpoints.

All group filtering must happen on the gateway using the authenticated MOMAS
operator's organization/group scope. Hiding an unauthorized group in the
browser is not sufficient.

Only one operator may hold the live console in this first release. PTT is
automatically released after the configured safety limit and whenever the
browser disconnects.

### Configuration

Use a dedicated active POCSTARS dispatcher account. Reusing a human operator's
account may terminate their dispatcher session.

```dotenv
POCSTARS_PTT_CONTROL_HOST=192.168.1.65
POCSTARS_PTT_CONTROL_PORT=22055
POCSTARS_PTT_AUDIO_HOST=192.168.1.65
POCSTARS_PTT_ACCOUNT=dedicated-momas-dispatcher
POCSTARS_PTT_PASSWORD=vendor-supplied-password-or-hash
POCSTARS_PTT_MAX_SECONDS=60
```

Leave `POCSTARS_PTT_CONTROL_HOST` empty to disable live calls safely.
The backend must run on the POCSTARS private network (or a routed VPN) because
live audio is UDP. A normal SSH `-L` tunnel can validate the TCP login and
group query, but it does not carry RTP audio.

For a non-transmitting control smoke test from a development machine:

```bash
ssh -p 2966 -N \
  -L 19220:192.168.1.65:22055 \
  administrator@POCSTARS_PUBLIC_IP
```

Then point only `POCSTARS_PTT_CONTROL_HOST/PORT` at `127.0.0.1:19220`.
Do not start a private call until a controlled test radio is nominated.

### Browser protocol

The authenticated endpoint is:

```text
GET /api/pocstars/radio/live  (WebSocket upgrade)
```

JSON controls are `call.start`, `call.end`, `ptt.start`, and `ptt.stop`.
Binary WebSocket messages carry headerless AMR-NB frames in both directions.
The backend rechecks the selected device against the signed-in operator's
organization and unit before sending `SingleCall` to POCSTARS.

### Public HTTPS proxy

The public API host must proxy both ordinary HTTP and WebSocket upgrades to the
Bun backend. An installable nginx example is provided at
`deploy/nginx-momas.conf.example`.

Verify that the public hostname reaches MOMAS:

```bash
bun run check:live-deploy -- https://memmcolapps.memmserve.com
```

The response must identify the runtime as `bun`. A Spring/WebFlux JSON 404
means the hostname is routed to the wrong upstream. After installing the
virtual host, `nginx -t` must pass before reloading nginx.

## Still required before field acceptance

- a dedicated production dispatcher login with access to the field groups;
- one nominated test handset, so private call, incoming audio and PTT can be
  verified without disturbing operational radios;
- confirmation of the permitted concurrent-login policy for that account.

SOS acknowledgement and resolution are documented separately in
`POCSTARS_SOS_API.md`; those actions already use the server's HTTP API and do
not require the radio SDK.
