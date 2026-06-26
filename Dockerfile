FROM denoland/deno:2.9.0@sha256:690c343f50ee4ceaae179f480fb110b3146b9428fbf676cac9fe21c62438e229 AS build

ENV DENO_NO_PROMPT=1 \
    DENO_NO_UPDATE_CHECK=1
WORKDIR /workspace
RUN chown deno:deno /workspace
COPY --chown=deno:deno . .
USER deno:deno
RUN deno task verify
RUN deno task compile:container

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:949e6cfda7141a19179964a7eb60d83c9eb1366c6b2cd36a6fd6f28c6baea8b9 AS runtime

LABEL org.opencontainers.image.title="ca-arcgis-api" \
      org.opencontainers.image.description="Read-only normalized CA pool status API" \
      org.opencontainers.image.source="https://github.com/simonua/ca-arcgis-api" \
      org.opencontainers.image.licenses="MIT"
ENV DENO_NO_PROMPT=1 \
    DENO_NO_UPDATE_CHECK=1
COPY --from=build --chown=65532:65532 --chmod=0555 /workspace/ca-arcgis-api /ca-arcgis-api

# Azure Container Apps owns HTTP probes; no shell or probe utility is added to this image.
EXPOSE 8080/tcp
STOPSIGNAL SIGTERM
USER 65532:65532
ENTRYPOINT ["/ca-arcgis-api"]
