# syntax=docker/dockerfile:1.7

FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:a718212f9cf21e241f14067333000a3f0930292f5354fe0db269e9a2a2596b9e AS hostname-edge

# These defaults are intentionally local/non-routable. Production DNS and TLS
# termination live outside this provider-neutral routing layer.
ENV PLATFORM_ADMIN_HOST=admin.hyperion.test \
    NOVA_HOST=nova.hyperion.test \
    COOPFUTURO_HOST=coopfuturo.hyperion.test \
    LUMEN_HOST=lumen.hyperion.test \
    PULSO_HOST=pulso.hyperion.test \
    PLATFORM_ADMIN_CONSOLE_UPSTREAM=http://platform-admin-console:8080 \
    PLATFORM_ADMIN_BFF_UPSTREAM=http://platform-admin-bff:8098 \
    NOVA_CONSOLE_UPSTREAM=http://nova-console:8080 \
    NOVA_BFF_UPSTREAM=http://nova-bff:8095 \
    COOPFUTURO_CONSOLE_UPSTREAM=http://coopfuturo-console:3000 \
    LUMEN_CONSOLE_UPSTREAM=http://lumen-console:8080 \
    LUMEN_BFF_UPSTREAM=http://lumen-bff:8096 \
    PULSO_CONSOLE_UPSTREAM=http://pulso-console:8080 \
    PULSO_BFF_UPSTREAM=http://pulso-bff:8097 \
    EDGE_FORWARDED_PROTO=http \
    EDGE_TRUSTED_PROXY_CIDR=127.0.0.1/32 \
    NGINX_ENVSUBST_FILTER='^(PLATFORM_ADMIN_HOST|NOVA_HOST|COOPFUTURO_HOST|LUMEN_HOST|PULSO_HOST|PLATFORM_ADMIN_CONSOLE_UPSTREAM|PLATFORM_ADMIN_BFF_UPSTREAM|NOVA_CONSOLE_UPSTREAM|NOVA_BFF_UPSTREAM|COOPFUTURO_CONSOLE_UPSTREAM|LUMEN_CONSOLE_UPSTREAM|LUMEN_BFF_UPSTREAM|PULSO_CONSOLE_UPSTREAM|PULSO_BFF_UPSTREAM|EDGE_FORWARDED_PROTO|EDGE_TRUSTED_PROXY_CIDR|NOVA_PROVIDER_EDGE_TOKEN)$'

COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY snippets/ /etc/nginx/snippets/

EXPOSE 8080
