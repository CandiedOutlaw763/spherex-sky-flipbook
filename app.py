"""Vercel entrypoint: Vercel looks for a FastAPI `app` in a root app.py."""

from backend.app import app  # noqa: F401
