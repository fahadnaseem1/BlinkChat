package com.blinkchat;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class BlinkChatApplication {

    public static void main(String[] args) {
        SpringApplication.run(BlinkChatApplication.class, args);
    }
}
