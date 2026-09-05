package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"sort"

	"github.com/FelippeRibeiro/go-live/internal/db"

	"github.com/joho/godotenv"
)

var schemaMigrationSQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    id BIGSERIAL PRIMARY KEY,
    filename TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
`

func main() {
	if err := godotenv.Load(); err != nil {
		log.Fatalf("Erro ao carregar .env: %v", err)
	}

	args := os.Args[1:]
	if len(args) == 0 {
		log.Fatal("Uso: go run cmd/migrations/run.go [up|reset]")
	}

	switch args[0] {
	case "up":
		up()
	case "reset":
		reset()
	default:
		log.Fatalf("Comando inválido: %v", args[0])
	}
}

func up() {
	_, conn, err := db.NewConn()
	if err != nil {
		log.Fatalf("Erro ao conectar ao banco de dados: %v", err)
	}
	defer conn.Close()

	_, err = conn.ExecContext(context.Background(), schemaMigrationSQL)
	if err != nil {
		log.Fatalf("Erro ao criar tabela de schema migrations: %v", err)
	}

	arquivos, err := os.ReadDir("db/schema")
	if err != nil {
		log.Fatalf("Erro ao ler diretório de migrations: %v", err)
	}

	var nomesArquivos []string
	for _, arquivo := range arquivos {
		if arquivo.IsDir() {
			continue
		}
		nomesArquivos = append(nomesArquivos, arquivo.Name())
	}

	sort.Strings(nomesArquivos)

	for _, arquivo := range nomesArquivos {
		rows, err := conn.QueryContext(context.Background(), "SELECT 1 FROM schema_migrations WHERE filename = $1", arquivo)
		if err != nil {
			log.Fatalf("Erro ao verificar se a migration existe: %v", err)
		}

		alreadyApplied := rows.Next()
		rows.Close()

		if alreadyApplied {
			fmt.Println("Migration " + arquivo + " já executada")
			continue
		}

		fmt.Println("Executando migration:", arquivo)
		sql, err := os.ReadFile(fmt.Sprintf("db/schema/%s", arquivo))
		if err != nil {
			log.Fatalf("Erro ao ler arquivo de migration: %v", err)
		}

		tx, err := conn.BeginTx(context.Background(), nil)
		if err != nil {
			log.Fatalf("Erro ao iniciar transação: %v", err)
		}

		_, err = tx.ExecContext(context.Background(), string(sql))
		if err != nil {
			tx.Rollback()
			log.Fatalf("Erro ao executar migration: %v", err)
		}

		_, err = tx.ExecContext(context.Background(), "INSERT INTO schema_migrations (filename) VALUES ($1)", arquivo)
		if err != nil {
			tx.Rollback()
			log.Fatalf("Erro ao inserir migration no banco de dados: %v", err)
		}

		if err := tx.Commit(); err != nil {
			log.Fatalf("Erro ao executar commit: %v", err)
		}

		fmt.Println("Migration executada com sucesso:", arquivo)
	}
}

func reset() {
	_, conn, err := db.NewConn()
	if err != nil {
		log.Fatalf("Erro ao conectar ao banco de dados: %v", err)
	}
	defer conn.Close()

	rows, err := conn.QueryContext(context.Background(), `
		SELECT tablename FROM pg_tables WHERE schemaname = 'public'
	`)
	if err != nil {
		log.Fatalf("Erro ao listar tabelas: %v", err)
	}
	defer rows.Close()

	var tabelas []string
	for rows.Next() {
		var nome string
		if err := rows.Scan(&nome); err != nil {
			log.Fatalf("Erro ao ler tabela: %v", err)
		}
		tabelas = append(tabelas, nome)
	}
	if err := rows.Err(); err != nil {
		log.Fatalf("Erro ao iterar tabelas: %v", err)
	}

	if len(tabelas) == 0 {
		fmt.Println("Nenhuma tabela encontrada")
		return
	}

	fmt.Println("Tabelas encontradas:", tabelas)

	for _, tabela := range tabelas {
		query := fmt.Sprintf(`DROP TABLE IF EXISTS public.%q CASCADE`, tabela)
		if _, err := conn.ExecContext(context.Background(), query); err != nil {
			log.Fatalf("Erro ao deletar tabela %s: %v", tabela, err)
		}
		fmt.Printf("Tabela %s deletada\n", tabela)
	}
}
