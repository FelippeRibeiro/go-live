package main

import (
	"fmt"
	"log"
	"os"

	"go-config/internal/middleware"

	"github.com/joho/godotenv"
)

func main() {
	if err := godotenv.Load(); err != nil {
		log.Fatalf("Error loading .env file: %v", err)
	}

	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		log.Fatal("JWT_SECRET não está definida no .env")
	}

	token, err := middleware.GenerateExampleToken(secret)
	if err != nil {
		log.Fatalf("Failed to generate token: %v", err)
	}

	fmt.Println(token)
}
