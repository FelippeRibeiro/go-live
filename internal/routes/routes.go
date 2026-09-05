package routes

import (
	"net/http"

	"go-config/internal/handler"
	"go-config/internal/middleware"
	"go-config/internal/server"
)

type Deps struct {
	UserHandler *handler.UserHandler
	JWTSecret   string
}

func Register(mux *http.ServeMux, deps Deps) {
	mux.Handle("GET /health", middleware.Timing(http.HandlerFunc(handler.Health)))

	mux.Handle("GET /api/users/{id}", middleware.Timing(http.HandlerFunc(deps.UserHandler.GetByID)))
	mux.Handle("POST /api/users", middleware.Timing(http.HandlerFunc(deps.UserHandler.Create)))
	mux.Handle("GET /api/example/jwt", middleware.Timing(middleware.JWTExample(deps.JWTSecret)))

	mux.Handle("/", middleware.Timing(server.SPAHandler{Root: "public"}))
}
