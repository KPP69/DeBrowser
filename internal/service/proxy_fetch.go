package service

// Subscription download helpers (HTTP fetch, size limits, URL checks).

import (
	"context"
	"errors"
	"fmt"
	"github.com/KPP69/DeBrowser/internal/mihomo"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	proxyMaxFetchedBytes = 16 << 20
)

func fetchSubscriptionHTTP(ctx context.Context, rawURL string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "mihomo/"+strings.TrimPrefix(mihomo.CoreVersion, "v"))
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		// *url.Error embeds the full subscription URL (token
		// included) in its message. Operation errors are
		// recorded verbatim in the unified log, and subscription
		// URLs must never be logged — unwrap to the inner
		// network error, which carries the useful cause only.
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err
		}
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("服务器返回 %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, proxyMaxFetchedBytes))
}
