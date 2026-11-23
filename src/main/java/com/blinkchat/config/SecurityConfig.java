package com.blinkchat.config;

import com.blinkchat.identity.*;
import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.IOException;
import java.util.List;
import org.springframework.context.annotation.*;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.*;
import org.springframework.security.web.authentication.AnonymousAuthenticationFilter;
import org.springframework.security.web.csrf.*;
import org.springframework.web.filter.OncePerRequestFilter;

@Configuration
public class SecurityConfig {

    @Bean
    SecurityFilterChain security(
        HttpSecurity http,
        GuestIdentityService identity
    ) throws Exception {
        http.authorizeHttpRequests(a ->
            a
                .requestMatchers(
                    "/",
                    "/index.html",
                    "/*.js",
                    "/*.css",
                    "/vendor/**",
                    "/api/csrf",
                    "/api/health",
                    "/api/guests",
                    "/api/invites/preview",
                    "/error"
                )
                .permitAll()
                .anyRequest()
                .authenticated()
        )
            .csrf(c -> c.csrfTokenRepository(new HttpSessionCsrfTokenRepository()))
            .requestCache(c -> c.disable())
            .formLogin(c -> c.disable())
            .httpBasic(c -> c.disable())
            .exceptionHandling(e ->
                e
                    .authenticationEntryPoint((req, res, ex) -> {
                        res.setStatus(401);
                        res.setContentType("application/json");
                        res.getWriter().write(
                            "{\"category\":\"session_expired\",\"message\":\"Choose a name to start a guest session.\"}"
                        );
                    })
                    .accessDeniedHandler((req, res, ex) -> {
                        res.setStatus(403);
                        res.setContentType("application/json");
                        res.getWriter().write(
                            "{\"category\":\"forbidden\",\"message\":\"Request could not be authorized. Refresh and try again.\"}"
                        );
                    })
            )
            .headers(h ->
                h
                    .contentSecurityPolicy(c ->
                        c.policyDirectives(
                            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
                        )
                    )
                    .referrerPolicy(r ->
                        r.policy(
                            org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy.NO_REFERRER
                        )
                    )
            )
            .addFilterBefore(
                new OncePerRequestFilter() {
                    protected void doFilterInternal(
                        HttpServletRequest req,
                        HttpServletResponse res,
                        FilterChain chain
                    ) throws ServletException, IOException {
                        // Resolve the opaque cookie on each request so revoked credentials stop working.
                        GuestPrincipal p = null;
                        if (req.getCookies() != null) {
                            for (Cookie c : req.getCookies()) {
                                if (c.getName().equals("BLINK_GUEST")) {
                                    p = identity.resolve(c.getValue());
                                }
                            }
                        }
                        if (p != null) {
                            SecurityContextHolder.getContext().setAuthentication(
                                new UsernamePasswordAuthenticationToken(p, null, List.of())
                            );
                        }
                        if (req.getRequestURI().startsWith("/api/")) {
                            res.setHeader("Cache-Control", "no-store");
                        }
                        chain.doFilter(req, res);
                    }
                },
                AnonymousAuthenticationFilter.class
            );
        return http.build();
    }
}
