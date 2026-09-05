package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/FelippeRibeiro/go-live/internal/db"
	"github.com/FelippeRibeiro/go-live/internal/handler"
	"github.com/FelippeRibeiro/go-live/internal/repository"
	"github.com/FelippeRibeiro/go-live/internal/routes"

	"github.com/joho/godotenv"
)

func main() {
	if err := godotenv.Load(); err != nil {
		log.Fatalf("Error loading .env file: %v", err)
	}

	if err := db.Init(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.GetDB().Close()

	userRepo := repository.NewUserRepository(db.GetQueries())
	userHandler := handler.NewUserHandler(userRepo)

	mux := http.NewServeMux()
	routes.Register(mux, routes.Deps{
		UserHandler: userHandler,
		JWTSecret:   os.Getenv("JWT_SECRET"),
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		slog.Info("server starting", "port", port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("Failed to start server: %v", err)
		}
	}()

	<-ctx.Done()
	slog.Info("server shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("Server shutdown failed: %v", err)
	}

	fmt.Println("Server stopped")
}
