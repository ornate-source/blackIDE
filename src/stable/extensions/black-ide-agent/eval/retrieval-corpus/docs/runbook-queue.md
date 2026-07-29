# Runbook — queue backlog and dead letters

## Symptom: `orders.created` backlog growing

1. Is the worker alive? A pod stuck in `Terminating` still holds its consumer
   registration until the visibility timeout expires.
2. Check the dead-letter topic depth. A steady trickle is normal; a step change
   means one *kind* of message is failing, not the broker.
3. Read three dead-lettered bodies before touching anything. `ErrPermanent`
   failures — malformed payloads, missing order ids — are a producer bug and
   replaying them will just fill the topic again.

## Replaying dead letters

Replay is manual on purpose. Publish back to the source topic in small batches and
watch the failure rate; an automatic replay loop turns one bad producer deploy
into an unbounded retry storm.

## Backoff

`worker/retry.go` uses full jitter. If you are tempted to remove the jitter to make
delays predictable in a test, don't — the predictability is the failure mode. Fix
the test by injecting the `Backoff` value instead.
