// Reconnect with backoff; the caller restores durable state from HTTP snapshots.
export function connect(csrf, onEvent, onState, onError) {
    const client = new StompJs.Client({
        brokerURL: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
        connectHeaders: { [csrf.headerName]: csrf.token },
        heartbeatIncoming: 10000,
        heartbeatOutgoing: 10000,
        reconnectDelay: 1000 + Math.floor(Math.random() * 500),
        maxReconnectDelay: 30000,
        reconnectTimeMode: StompJs.ReconnectionTimeMode.EXPONENTIAL,
        debug: () => {},
    });
    client.onConnect = () => {
        client.subscribe('/user/queue/events', (m) => onEvent(JSON.parse(m.body)));
        client.subscribe('/user/queue/errors', (m) => onError(JSON.parse(m.body)));
        onState(true);
    };
    client.onWebSocketClose = () => onState(false);
    client.onStompError = () => {
        onState(false);
        onError({ message: 'Connection could not be authorized. Refresh to try again.' });
    };
    client.activate();
    return {
        send(type, data) {
            if (!client.connected) {
                throw new Error('Reconnect before sending.');
            }
            client.publish({ destination: '/app/chat.' + type, body: JSON.stringify(data) });
        },
        close() {
            client.deactivate();
        },
    };
}
