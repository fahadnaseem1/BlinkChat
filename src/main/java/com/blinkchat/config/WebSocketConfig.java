package com.blinkchat.config;

import com.blinkchat.identity.*;
import com.blinkchat.messaging.Connections;
import java.time.*;
import java.util.Set;
import org.springframework.context.annotation.*;
import org.springframework.messaging.*;
import org.springframework.messaging.simp.config.*;
import org.springframework.messaging.simp.stomp.*;
import org.springframework.messaging.support.*;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.security.messaging.web.csrf.XorCsrfChannelInterceptor;
import org.springframework.security.messaging.web.socket.server.CsrfTokenHandshakeInterceptor;
import org.springframework.web.socket.*;
import org.springframework.web.socket.config.annotation.*;
import org.springframework.web.socket.handler.WebSocketHandlerDecorator;

@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    private final Policy policy;
    private final GuestIdentityService identity;
    private final Connections connections;

    public WebSocketConfig(Policy p, GuestIdentityService i, Connections c) {
        policy = p;
        identity = i;
        connections = c;
    }

    @Bean(name = { "brokerScheduler", "taskScheduler" })
    public ThreadPoolTaskScheduler brokerScheduler() {
        ThreadPoolTaskScheduler s = new ThreadPoolTaskScheduler();
        s.setPoolSize(2);
        s.setThreadNamePrefix("stomp-heartbeat-");
        s.initialize();
        return s;
    }

    public void registerStompEndpoints(StompEndpointRegistry r) {
        r.setPreserveReceiveOrder(true);
        r.addEndpoint("/ws")
            .setAllowedOrigins(policy.origin)
            .addInterceptors(new CsrfTokenHandshakeInterceptor());
    }

    public void configureMessageBroker(MessageBrokerRegistry r) {
        r.enableSimpleBroker("/queue")
            .setTaskScheduler(brokerScheduler())
            .setHeartbeatValue(new long[] { 10000, 10000 });
        r.setApplicationDestinationPrefixes("/app");
        r.setUserDestinationPrefix("/user");
        r.setPreservePublishOrder(true);
    }

    public void configureWebSocketTransport(WebSocketTransportRegistration r) {
        r.setMessageSizeLimit(16384).setSendBufferSizeLimit(65536).setSendTimeLimit(10000);
        r.addDecoratorFactory(handler ->
            new WebSocketHandlerDecorator(handler) {
                public void afterConnectionEstablished(WebSocketSession s) throws Exception {
                    connections.add(s);
                    if (s.isOpen()) {
                        super.afterConnectionEstablished(s);
                    }
                }

                public void afterConnectionClosed(
                    WebSocketSession s,
                    CloseStatus status
                ) throws Exception {
                    connections.remove(s.getId());
                    super.afterConnectionClosed(s, status);
                }
            }
        );
    }

    // Restrict clients to their own queues and the application commands we handle.
    public void configureClientInboundChannel(ChannelRegistration r) {
        r.taskExecutor().corePoolSize(2).maxPoolSize(8).queueCapacity(256);
        r.interceptors(
            new ChannelInterceptor() {
                public Message<?> preSend(Message<?> m, MessageChannel ch) {
                    StompHeaderAccessor a = StompHeaderAccessor.wrap(m);
                    try {
                        if (a.getCommand() == StompCommand.DISCONNECT) {
                            return m;
                        }
                        GuestPrincipal p = Connections.principal(a.getUser());
                        identity.require(p);
                        StompCommand command = a.getCommand();
                        if (command == StompCommand.SEND) {
                            connections.limitCommand(
                                a.getSessionId(),
                                "/app/chat.send".equals(a.getDestination())
                            );
                        }
                        if (
                            command == StompCommand.SUBSCRIBE &&
                            !Set.of("/user/queue/events", "/user/queue/errors").contains(
                                a.getDestination()
                            )
                        ) {
                            throw new org.springframework.security.access.AccessDeniedException(
                                "Subscription denied"
                            );
                        }
                        if (
                            command == StompCommand.SEND &&
                            !Set.of(
                                "/app/chat.send",
                                "/app/chat.delivered",
                                "/app/chat.seen",
                                "/app/chat.typing"
                            ).contains(a.getDestination())
                        ) {
                            throw new org.springframework.security.access.AccessDeniedException(
                                "Command denied"
                            );
                        }
                        new XorCsrfChannelInterceptor().preSend(m, ch);
                        return m;
                    } catch (RuntimeException e) {
                        connections.reject(a.getSessionId());
                        throw e;
                    }
                }
            }
        );
    }

    // A queued body may expire or lose authorization before the broker sends it.
    public void configureClientOutboundChannel(ChannelRegistration r) {
        r.taskExecutor().corePoolSize(2).maxPoolSize(8).queueCapacity(256);
        r.interceptors(
            new ChannelInterceptor() {
                public Message<?> preSend(Message<?> m, MessageChannel ch) {
                    StompHeaderAccessor a = StompHeaderAccessor.wrap(m);
                    if (a.getCommand() == StompCommand.MESSAGE) {
                        if (!connections.valid(a.getSessionId())) {
                            return null;
                        }
                        try {
                            if (m.getPayload() instanceof byte[] bytes) {
                                var event = new tools.jackson.databind.json.JsonMapper().readTree(
                                    bytes
                                );
                                var data = event.get("data");
                                if (
                                    data != null &&
                                    data.has("body") &&
                                    (!Instant.parse(data.get("disappearsAt").asString()).isAfter(
                                        java.time.Instant.now()
                                    ) ||
                                        !connections.canDeliverBody(
                                            a.getSessionId(),
                                            event.get("roomId").asString(),
                                            data.get("id").asString()
                                        ))
                                ) {
                                    return null;
                                }
                            }
                        } catch (RuntimeException ex) {
                            return null;
                        }
                    }
                    return m;
                }
            }
        );
    }
}
