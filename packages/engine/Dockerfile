# UNVERIFIED: written but never built — Docker was not available on the machine
# this was authored on. Expect to debug it the first time. The local venv path
# (./setup.sh) IS verified and is the one used for the demo.
#
# Build from the REPO ROOT, not this directory:
#   docker build -f packages/engine/Dockerfile -t agentgate-engine .
FROM python:3.12-slim
WORKDIR /app

COPY packages/shared /app/packages/shared
COPY packages/engine/requirements.txt /app/packages/engine/requirements.txt

RUN pip install --no-cache-dir -r packages/engine/requirements.txt

COPY packages/engine /app/packages/engine
RUN pip install --no-cache-dir -e packages/shared -e packages/engine

WORKDIR /app/packages/engine
ENV PORT=8000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT}"]
