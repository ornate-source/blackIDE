package worker

import (
	"context"
	"encoding/json"
	"errors"
	"log"
)

// OrderCreated is the event the API publishes once payment is captured.
type OrderCreated struct {
	OrderID    string `json:"order_id"`
	CustomerID string `json:"customer_id"`
	TotalMinor int64  `json:"total_minor"`
	Currency   string `json:"currency"`
}

// ErrPermanent marks a failure that retrying cannot fix — a malformed body, an
// order that no longer exists. These go straight to the dead-letter topic rather
// than burning five attempts first.
var ErrPermanent = errors.New("permanent failure")

// HandleOrderCreated fulfils one order-created event: it schedules the shipment
// and emits the fulfilment event the analytics rollup reads.
func HandleOrderCreated(ctx context.Context, q Queue, m Message) error {
	var event OrderCreated
	if err := json.Unmarshal(m.Body, &event); err != nil {
		return errors.Join(ErrPermanent, err)
	}
	if event.OrderID == "" {
		return errors.Join(ErrPermanent, errors.New("event has no order id"))
	}

	if err := scheduleShipment(ctx, event); err != nil {
		return err
	}

	return q.Publish(ctx, "orders.fulfilled", map[string]any{
		"order_id":    event.OrderID,
		"customer_id": event.CustomerID,
	})
}

// Consume pulls order-created events and dispatches them, acking on success,
// nacking with backoff on a transient failure, and dead-lettering the rest.
func Consume(ctx context.Context, q Queue) error {
	messages := make(chan Message)
	go func() {
		if err := q.Consume(ctx, "orders.created", messages); err != nil {
			log.Printf("consume loop stopped: %v", err)
		}
	}()

	for m := range messages {
		err := HandleOrderCreated(ctx, q, m)
		switch {
		case err == nil:
			if ackErr := q.Ack(ctx, m); ackErr != nil {
				log.Printf("ack %s: %v", m.ID, ackErr)
			}
		case errors.Is(err, ErrPermanent), m.Attempts >= maxAttempts:
			if dlErr := deadLetter(ctx, q, m, err); dlErr != nil {
				log.Printf("dead-letter %s: %v", m.ID, dlErr)
			}
		default:
			if nackErr := q.Nack(ctx, m, retryDelay(m.Attempts+1)); nackErr != nil {
				log.Printf("nack %s: %v", m.ID, nackErr)
			}
		}
	}
	return ctx.Err()
}

func scheduleShipment(ctx context.Context, event OrderCreated) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		log.Printf("scheduling shipment for %s", event.OrderID)
		return nil
	}
}
