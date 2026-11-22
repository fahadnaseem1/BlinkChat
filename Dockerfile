FROM eclipse-temurin:21-jdk AS build
WORKDIR /app
COPY gradle gradle
COPY gradlew build.gradle settings.gradle ./
COPY src src
RUN chmod +x gradlew && ./gradlew bootJar --no-daemon
FROM eclipse-temurin:21-jre
WORKDIR /app
RUN mkdir /data && chown 10001:10001 /data
COPY --from=build /app/build/libs/BlinkChat-0.0.1-SNAPSHOT.jar app.jar
USER 10001
ENV SPRING_PROFILES_ACTIVE=hosted BLINK_DATA_DIR=/data
EXPOSE 8080
ENTRYPOINT ["java","-jar","app.jar"]
