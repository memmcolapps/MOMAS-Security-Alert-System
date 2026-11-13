// One EventSource shared by every part of the page that listens to the same
// stream. Browsers allow only six HTTP/1.1 connections per server, so three
// components each holding their own copy of the alerts feed left too few for
// ordinary requests.
//
// The connection opens with the first subscriber and closes with the last.
// If the stream's URL has changed by the time someone subscribes (a new
// sign-in or organisation), it is reopened on the new URL for everyone.

export function createSharedEventSource({ getUrl, events, makeSource = (url) => new window.EventSource(url) }) {
  const subscribers = new Set();
  let source = null;
  let url = null;
  let connected = false;

  const each = (method, event) => {
    for (const subscriber of subscribers) {
      try {
        subscriber[method]?.(event);
      } catch {
        // One listener throwing must not stop the others hearing the event.
      }
    }
  };

  function close() {
    if (!source) return;
    source.close();
    source = null;
    url = null;
    if (connected) {
      connected = false;
      each("onError");
    }
  }

  function open(nextUrl) {
    url = nextUrl;
    const current = makeSource(nextUrl);
    source = current;
    current.addEventListener("open", (event) => {
      if (source !== current) return;
      connected = true;
      each("onOpen", event);
    });
    current.addEventListener("error", (event) => {
      if (source !== current) return;
      connected = false;
      each("onError", event);
    });
    for (const name of events) {
      current.addEventListener(name, (event) => {
        if (source !== current) return;
        for (const subscriber of subscribers) {
          try {
            subscriber.onEvent?.(name, event);
          } catch {
            // As above.
          }
        }
      });
    }
  }

  return {
    // subscriber: { onEvent(name, event), onOpen(event), onError(event) }
    subscribe(subscriber) {
      subscribers.add(subscriber);
      const nextUrl = getUrl();
      if (source && url !== nextUrl) close();
      if (!source) open(nextUrl);
      else if (connected) subscriber.onOpen?.();
      return () => {
        subscribers.delete(subscriber);
        if (subscribers.size === 0) close();
      };
    },
    isConnected: () => connected,
  };
}
