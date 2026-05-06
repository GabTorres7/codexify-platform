from fastapi import APIRouter

from app.api.v1 import (
    analyses,
    auth,
    dashboard,
    merge_requests,
    organizations,
    repositories,
    rules,
    webhooks,
)

api_router = APIRouter()

api_router.include_router(auth.router)
api_router.include_router(organizations.router)
api_router.include_router(repositories.router)
api_router.include_router(merge_requests.router)
api_router.include_router(analyses.router)
api_router.include_router(rules.router)
api_router.include_router(webhooks.router)
api_router.include_router(dashboard.router)
