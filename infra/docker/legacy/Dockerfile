# syntax=docker/dockerfile:1.7

FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS web-console

COPY default.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 8080
