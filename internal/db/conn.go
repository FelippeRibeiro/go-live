package db

import (
	"database/sql"
	"fmt"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"
)

var (
	globalQueries *Queries
	globalDB      *sql.DB
)

func Init() error {
	dbURL := os.Getenv("DB_URL")
	if dbURL == "" {
		return fmt.Errorf("DB_URL não está definida no arquivo .env")
	}
	var err error
	globalDB, err = sql.Open("pgx", dbURL)
	if err != nil {
		return fmt.Errorf("erro ao conectar ao banco: %w", err)
	}
	if err = globalDB.Ping(); err != nil {
		return fmt.Errorf("erro ao pingar o banco: %w", err)
	}
	globalQueries = New(globalDB)
	return nil
}

func GetQueries() *Queries {
	return globalQueries
}

func GetDB() *sql.DB {
	return globalDB
}

// NewConn is kept for the migration runner.
func NewConn() (*Queries, *sql.DB, error) {
	dbURL := os.Getenv("DB_URL")
	if dbURL == "" {
		return nil, nil, fmt.Errorf("DB_URL não está definida no arquivo .env")
	}
	conn, err := sql.Open("pgx", dbURL)
	if err != nil {
		return nil, nil, fmt.Errorf("erro ao conectar ao banco de dados: %w", err)
	}
	if err = conn.Ping(); err != nil {
		return nil, nil, fmt.Errorf("erro ao pingar o banco de dados: %w", err)
	}
	return New(conn), conn, nil
}
