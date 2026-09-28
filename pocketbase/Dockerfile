# Build from the official release; PocketBase does not publish an official image.
FROM alpine:3.21
ARG TARGETARCH
ARG PB_VERSION=0.26.6
RUN apk add --no-cache ca-certificates unzip wget \
    && wget -q "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_${TARGETARCH}.zip" -O /tmp/pb.zip \
    && unzip /tmp/pb.zip pocketbase -d /usr/local/bin \
    && rm /tmp/pb.zip
ENTRYPOINT ["pocketbase"]
CMD ["serve", "--http=0.0.0.0:8090", "--dir=/pb_data", "--migrationsDir=/pb_migrations"]
