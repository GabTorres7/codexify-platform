from fastapi import APIRouter

from app.api.v1 import (
    analyses,
    auth,
    billing,
    dashboard,
    merge_requests,
    organizations,
    public_api,
    repositories,
    rules,
    upload,
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
api_router.include_router(upload.router)
api_router.include_router(billing.router)
api_router.include_router(public_api.router)
