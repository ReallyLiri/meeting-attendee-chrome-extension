FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock ./

RUN pip install uv && uv sync --frozen

COPY . .

RUN mkdir -p data output model static

ENV PROD="TRUE"

CMD ["uv", "run", "src/server.py"]
