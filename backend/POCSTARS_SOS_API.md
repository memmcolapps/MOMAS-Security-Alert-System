# POCSTARS SOS API

The installed POCSTARS SOS service (`sl-service-sos` v2.1.4) exposes the
dispatcher actions MOMAS needs directly over HTTP. A separate SDK bridge is not
required.

Configure:

```dotenv
POCSTARS_SOS_BASE=http://143.105.173.49:6891
POCSTARS_TARGET_UID=583
POCSTARS_DISPATCHER_UID=583
```

`POCSTARS_TARGET_UID` selects the recipient feed that MOMAS imports.
`POCSTARS_DISPATCHER_UID` is recorded by POCSTARS as the dispatcher who starts
and closes an SOS.

### Start a response

```http
PUT /sos/mg/handle/begin?uid={dispatcherUid}&sosMsgId={sosMsgId}
```

The alarm must currently have POCSTARS status `0` (new). POCSTARS assigns the
dispatcher and changes the status to `1` (processing).

### Resolve an alarm

```http
PUT /sos/mg/handle/end?uid={dispatcherUid}&sosMsgId={sosMsgId}
```

The alarm must currently have POCSTARS status `1` (processing). POCSTARS changes
the status to `2` (closed), notifies the alarm originator and configured SOS
receivers, and records the close time and processor.

Both endpoints return POCSTARS' standard result envelope:

```json
{
  "code": 200,
  "message": "success",
  "data": null,
  "success": true
}
```

Relevant rejection codes are:

- `501`: insufficient permissions
- `502`: the SOS is already being processed by another dispatcher
- `503`: the dispatcher is already processing another SOS
- `504`: the SOS is in the wrong state

## Safety behavior

MOMAS marks an action as synchronizing before the request and only changes the
local alarm state after POCSTARS returns `code: 200` and `success: true`. On a
timeout or rejection, the alarm is marked `sync_failed`, and the error is added
to its activity history so an operator can retry.

The background synchronizer also reads POCSTARS statuses `1` (processing) and
`2` (closed). It advances matching alarms that MOMAS already imported and adds
an activity entry when the action happened outside MOMAS. It never moves an
alarm backward and never imports processing/resolved archive rows that MOMAS
did not previously know about. This reconciliation is what removes an alarm
from the operations map after it is manually resolved in POCSTARS.

The SOS service's current Spring Security configuration permits all HTTP
requests and disables CSRF, so no action token is required. Network access to
port `6891` should still be restricted to MOMAS and trusted administration
networks.
