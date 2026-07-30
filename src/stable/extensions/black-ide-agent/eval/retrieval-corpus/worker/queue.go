package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// Message is one unit of work pulled off the broker.
type Message struct {
	ID          string          `json:"id"`
	Topic       string          `json:"topic"`
	Body        json.RawMessage `json:"body"`
	Attempts    int             `json:"attempts"`
	EnqueuedAt  time.Time       `json:"enqueued_at"`
	VisibleFrom time.Time       `json:"visible_from"`
}

// Queue is the subset of the broker the worker actually uses. Kept narrow so the
// tests can substitute an in-memory implementation without a running broker.
type Queue interface {
	Consume(ctx context.Context, topic string, out chan<- Message) error
	Publish(ctx context.Context, topic string, body any) error
	Ack(ctx context.Context, m Message) error
	Nack(ctx context.Context, m Message, retryAfter time.Duration) error
}

const (
	maxAttempts       = 5
	baseRetryInterval = 2 * time.Second
	deadLetterTopic   = "orders.dead-letter"
)

// retryDelay grows exponentially with the attempt count and is capped, so a
// permanently broken message backs off instead of hot-looping the worker.
func retryDelay(attempts int) time.Duration {
	delay := baseRetryInterval << uint(attempts-1)
	if delay > time.Minute*10 {
		return time.Minute * 10
	}
	return delay
}

// deadLetter moves a message that has exhausted its attempts onto the dead-letter
// topic. Dropping it instead would lose an order, which is never acceptable here.
func deadLetter(ctx context.Context, q Queue, m Message, cause error) error {
	if err := q.Publish(ctx, deadLetterTopic, map[string]any{
		"original_id":    m.ID,
		"original_topic": m.Topic,
		"body":           m.Body,
		"attempts":       m.Attempts,
		"error":          cause.Error(),
	}); err != nil {
		return fmt.Errorf("publishing to dead-letter: %w", err)
	}
	return q.Ack(ctx, m)
}
