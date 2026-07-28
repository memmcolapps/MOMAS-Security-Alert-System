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
bootstrap is UDP port `10600`. The bootstrap service returns the actual voice
server; MOMAS should not implement that proprietary exchange when the native
SDK is available.

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

## What MOMAS still needs

Obtain one of the following from POCSTARS:

1. The native Qt dispatcher SDK/library and headers matching dispatcher
   `v2.12`, preferably with PCM audio input/output callbacks; or
2. A supported web/headless dispatcher SDK that exposes the same `context`
   operations.

The official site lists an Africa Qt 15.2 dispatcher build dated 13 June 2025,
but the download is account-gated. The native dispatcher installer was not
found on the server itself.

Also obtain:

- a dedicated dispatcher login for the MOMAS gateway;
- a licence that permits the required groups and concurrent monitoring;
- a controlled test group with two test radios;
- codec/audio callback documentation if it is not included with the SDK;
- confirmation of whether one dispatcher account may maintain simultaneous
  group monitors and a private/temporary call.

## Recommended MOMAS design

Run the vendor SDK in a small server-side radio gateway. Browsers should never
connect directly to the proprietary voice ports.

```text
POCSTARS native SDK
        |
MOMAS radio gateway
  - group/member permission checks
  - floor/PTT state
  - PCM/Opus conversion
  - recording proxy
        |
Authenticated WebSocket/WebRTC
        |
MOMAS operator UI
```

The gateway should expose a narrow MOMAS-owned interface for:

- permitted groups and online members;
- start/stop monitoring;
- current speaker/floor state;
- press/release PTT;
- private and temporary calls;
- carefully gated all-radio broadcast;
- recording search and playback.

All group filtering must happen on the gateway using the authenticated MOMAS
operator's organization/group scope. Hiding an unauthorized group in the
browser is not sufficient.

SOS acknowledgement and resolution are documented separately in
`POCSTARS_SOS_API.md`; those actions already use the server's HTTP API and do
not require the radio SDK.
