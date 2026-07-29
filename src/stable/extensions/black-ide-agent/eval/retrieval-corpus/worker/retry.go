package worker

import (
	"math"
	"math/rand"
	"time"
)

// Backoff policy shared by the outbound HTTP calls the worker makes. Distinct
// from the queue's own redelivery schedule in queue.go: that one is enforced by
// the broker's visibility timeout, this one runs inside a single handler.
type Backoff struct {
	Base       time.Duration
	Max        time.Duration
	Multiplier float64
	Jitter     bool
}

var DefaultBackoff = Backoff{
	Base:       200 * time.Millisecond,
	Max:        30 * time.Second,
	Multiplier: 2.0,
	Jitter:     true,
}

// Delay returns how long to wait before attempt n (1-based).
//
// Full jitter rather than the "equal jitter" variant: with a few thousand workers
// the difference in tail latency is small, but the difference in how hard they
// hammer a recovering dependency is not.
func (b Backoff) Delay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	raw := float64(b.Base) * math.Pow(b.Multiplier, float64(attempt-1))
	if raw > float64(b.Max) {
		raw = float64(b.Max)
	}
	if b.Jitter {
		raw = rand.Float64() * raw
	}
	return time.Duration(raw)
}

// Do runs fn, retrying transient failures up to attempts times.
func (b Backoff) Do(attempts int, fn func() error, retryable func(error) bool) error {
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		if err = fn(); err == nil {
			return nil
		}
		if attempt == attempts || (retryable != nil && !retryable(err)) {
			break
		}
		time.Sleep(b.Delay(attempt))
	}
	return err
}
