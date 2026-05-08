"""
Billing & Plans endpoints.

GET  /orgs/{org_id}/billing/plans       — list available plans
GET  /orgs/{org_id}/billing/subscription — current subscription + usage
POST /orgs/{org_id}/billing/change-plan  — switch to a different plan
POST /orgs/{org_id}/billing/checkout     — create Stripe checkout session (if configured)
POST /webhooks/stripe                    — Stripe webhook handler
"""
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Request

from app.config import get_settings
from app.db.client import get_supabase
from app.dependencies import get_current_user, require_admin
from app.services.billing_service import BillingService

logger = structlog.get_logger()
settings = get_settings()
router = APIRouter(tags=["Billing"])

_billing = BillingService()


@router.get("/orgs/{org_id}/billing/plans")
async def list_plans(
    org_id: UUID,
    _current_user: dict = Depends(get_current_user),
):
    """List all available plans with pricing and limits."""
    plans = await _billing.get_plans()
    return [
        {
            "slug": p["slug"],
            "name": p["name"],
            "price_monthly": p["price_monthly"],
            "price_yearly": p["price_yearly"],
            "max_repos": p["max_repos"],
            "max_analyses": p["max_analyses"],
            "max_members": p["max_members"],
            "max_chat_msgs": p["max_chat_msgs"],
            "features": p.get("features", []),
        }
        for p in plans
    ]


@router.get("/orgs/{org_id}/billing/subscription")
async def get_subscription(
    org_id: UUID,
    _current_user: dict = Depends(get_current_user),
):
    """Get current subscription details + monthly usage."""
    sub = await _billing.get_subscription(org_id)
    usage = await _billing.get_usage(org_id)

    plan = sub.get("plans", {}) if sub else {}
    return {
        "plan": {
            "slug": plan.get("slug", "free"),
            "name": plan.get("name", "Free"),
            "price_monthly": plan.get("price_monthly", 0),
            "max_repos": plan.get("max_repos", 3),
            "max_analyses": plan.get("max_analyses", 50),
            "max_members": plan.get("max_members", 3),
            "max_chat_msgs": plan.get("max_chat_msgs", 20),
            "features": plan.get("features", []),
        },
        "status": sub.get("status", "active") if sub else "active",
        "usage": {
            "analyses": usage.get("analyses", 0),
            "chat_msgs": usage.get("chat_msgs", 0),
            "api_calls": usage.get("api_calls", 0),
        },
    }


@router.post("/orgs/{org_id}/billing/change-plan")
async def change_plan(
    org_id: UUID,
    body: dict,
    _current_user: dict = Depends(require_admin),
):
    """
    Change the org's plan.
    Body: { "plan": "starter" | "pro" | "enterprise" | "free" }
    For paid plans with Stripe configured, returns a checkout URL.
    """
    plan_slug = body.get("plan", "").strip()
    if not plan_slug:
        return {"error": "Campo 'plan' obrigatório"}

    # If Stripe is configured and plan is paid, create checkout session
    stripe_key = getattr(settings, "stripe_secret_key", "")
    if stripe_key and plan_slug != "free":
        try:
            import stripe
            stripe.api_key = stripe_key

            plans = await _billing.get_plans()
            plan = next((p for p in plans if p["slug"] == plan_slug), None)
            if not plan:
                return {"error": f"Plano '{plan_slug}' nao encontrado"}

            # Find or create Stripe price (in a real app, store price_id in plans table)
            session = stripe.checkout.Session.create(
                mode="subscription",
                line_items=[{
                    "price_data": {
                        "currency": "usd",
                        "unit_amount": plan["price_monthly"],
                        "recurring": {"interval": "month"},
                        "product_data": {"name": f"Codexfy {plan['name']}"},
                    },
                    "quantity": 1,
                }],
                success_url=f"{settings.public_api_url}/app/index.html?billing=success",
                cancel_url=f"{settings.public_api_url}/app/index.html?billing=cancel",
                metadata={"org_id": str(org_id), "plan_slug": plan_slug},
            )
            return {"checkout_url": session.url, "session_id": session.id}

        except ImportError:
            logger.warning("stripe_not_installed")
        except Exception as exc:
            logger.error("stripe_checkout_error", error=str(exc))

    # No Stripe — just change plan directly
    result = await _billing.change_plan(org_id, plan_slug)
    return {
        "message": f"Plano alterado para {plan_slug}",
        "plan": result.get("plans", {}).get("slug", plan_slug),
    }


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request):
    """Handle Stripe webhook events for subscription updates."""
    stripe_key = getattr(settings, "stripe_secret_key", "")
    webhook_secret = getattr(settings, "stripe_webhook_secret", "")

    if not stripe_key:
        return {"status": "stripe_not_configured"}

    try:
        import stripe
        stripe.api_key = stripe_key

        payload = await request.body()
        sig = request.headers.get("stripe-signature", "")

        if webhook_secret:
            event = stripe.Webhook.construct_event(payload, sig, webhook_secret)
        else:
            import json
            event = json.loads(payload)

        event_type = event.get("type", "")

        if event_type == "checkout.session.completed":
            session = event["data"]["object"]
            org_id = session.get("metadata", {}).get("org_id")
            plan_slug = session.get("metadata", {}).get("plan_slug")
            if org_id and plan_slug:
                await _billing.change_plan(UUID(org_id), plan_slug)
                # Update Stripe IDs
                db = await get_supabase()
                await db.table("subscriptions").update({
                    "stripe_customer_id": session.get("customer"),
                    "stripe_subscription_id": session.get("subscription"),
                }).eq("org_id", org_id).execute()
                logger.info("stripe_plan_activated", org_id=org_id, plan=plan_slug)

        elif event_type in ("customer.subscription.deleted", "customer.subscription.updated"):
            sub_obj = event["data"]["object"]
            stripe_sub_id = sub_obj.get("id")
            status = sub_obj.get("status")

            db = await get_supabase()
            sub_resp = (
                await db.table("subscriptions")
                .select("id, org_id")
                .eq("stripe_subscription_id", stripe_sub_id)
                .limit(1)
                .execute()
            )
            if sub_resp.data:
                mapped_status = {
                    "active": "active",
                    "canceled": "canceled",
                    "past_due": "past_due",
                    "trialing": "trialing",
                }.get(status, "active")

                await db.table("subscriptions").update({
                    "status": mapped_status,
                }).eq("id", sub_resp.data[0]["id"]).execute()  # type: ignore[index]

        return {"status": "ok"}

    except Exception as exc:
        logger.error("stripe_webhook_error", error=str(exc))
        return {"status": "error", "detail": str(exc)}
