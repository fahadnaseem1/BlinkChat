package com.blinkchat.controller;

import com.blinkchat.service.Problem;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

/** Translates failures into client messages without exposing internal exception details. */
@RestControllerAdvice
public class Errors {

    @ExceptionHandler(Problem.class)
    public ResponseEntity<?> domain(Problem p) {
        return ResponseEntity.status(p.status).body(p.payload());
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<?> other(Exception e) {
        boolean invalid =
            e instanceof org.springframework.http.converter.HttpMessageNotReadableException ||
            e instanceof
                org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
        Problem p = invalid
            ? Problem.invalid("Check the request fields and try again.")
            : new Problem(
                  500,
                  "server_failure",
                  "The request could not be completed. Please try again."
              );
        return domain(p);
    }
}
