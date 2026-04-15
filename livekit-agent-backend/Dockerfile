FROM python:3.11-slim-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements and install
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Create logs directory if it doesn't exist
RUN mkdir -p logs

# Run the agent in "dev" mode if needed, or just run it
# cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint)) will start the worker
CMD ["python", "agent.py", "dev"]
