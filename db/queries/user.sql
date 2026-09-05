-- name: GetUser :one
SELECT * FROM users WHERE id = $1;

-- name: CreateUser :one
INSERT INTO users (nome, email, password) VALUES ($1, $2, $3) RETURNING *;

-- name: UpdateUser :one
UPDATE users SET nome = $1, email = $2, password = $3 WHERE id = $4 RETURNING *;

-- name: DeleteUser :one
DELETE FROM users WHERE id = $1 RETURNING *;
