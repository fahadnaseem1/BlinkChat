# syntax=docker/dockerfile:1

# Compile with Java 21. Gradle downloads stay in BuildKit's cache, outside the image.
FROM eclipse-temurin:21-jdk-jammy AS build
WORKDIR /app
COPY gradle gradle
COPY gradlew build.gradle settings.gradle ./
RUN chmod +x gradlew
COPY src/main src/main
RUN --mount=type=cache,target=/root/.gradle \
    ./gradlew bootJar --no-daemon && cp build/libs/*.jar /app/app.jar

FROM eclipse-temurin:21-jre-jammy AS runtime
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 blinkchat \
    && useradd --uid 10001 --gid blinkchat --no-create-home --shell /usr/sbin/nologin blinkchat \
    && mkdir -p /data/blinkchat \
    && chown blinkchat:blinkchat /data/blinkchat
COPY --from=build /app/app.jar /app/app.jar
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/blinkchat-entrypoint

ENV PORT=8080 \
    SPRING_PROFILES_ACTIVE=hosted \
    BLINK_DATA_DIR=/data/blinkchat \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=50.0 -XX:InitialRAMPercentage=10.0 -XX:+ExitOnOutOfMemoryError"

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl --fail --silent --show-error "http://127.0.0.1:${PORT}/api/health" || exit 1

# Initialize ownership after the persistent disk is mounted, then exec Java as UID 10001.
ENTRYPOINT ["/usr/local/bin/blinkchat-entrypoint"]
CMD ["java", "-jar", "/app/app.jar"]
