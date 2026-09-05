# Build
FROM golang:1.22-alpine AS build
WORKDIR /src

RUN apk add --no-cache git ca-certificates

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/go-live .

# Runtime
FROM alpine:3.20
WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata \
  && adduser -D -H -u 10001 appuser

COPY --from=build /out/go-live /app/go-live
COPY public /app/public

USER appuser
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/app/go-live"]
