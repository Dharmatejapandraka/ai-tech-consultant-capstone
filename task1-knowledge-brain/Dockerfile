FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --default-timeout=1000 --index-url https://download.pytorch.org/whl/cpu torch
RUN pip install --no-cache-dir --default-timeout=1000 -r requirements.txt
COPY app ./app
RUN mkdir -p /app/data
ENV DATABASE_PATH=/app/data/knowledge.db
EXPOSE 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
