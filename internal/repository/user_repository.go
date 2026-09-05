package repository

import (
	"context"

	"github.com/FelippeRibeiro/go-live/internal/db"
)

type UserRepository interface {
	GetByID(ctx context.Context, id int32) (db.User, error)
	Create(ctx context.Context, params db.CreateUserParams) (db.User, error)
}

type userRepository struct {
	queries *db.Queries
}

func NewUserRepository(queries *db.Queries) UserRepository {
	return &userRepository{queries: queries}
}

func (r *userRepository) GetByID(ctx context.Context, id int32) (db.User, error) {
	return r.queries.GetUser(ctx, id)
}

func (r *userRepository) Create(ctx context.Context, params db.CreateUserParams) (db.User, error) {
	return r.queries.CreateUser(ctx, params)
}
