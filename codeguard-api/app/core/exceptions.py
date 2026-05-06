class CodeGuardException(Exception):
    def __init__(self, message: str, error_code: str, status_code: int = 400):
        self.message = message
        self.error_code = error_code
        self.status_code = status_code
        super().__init__(message)


class NotFoundError(CodeGuardException):
    def __init__(self, resource: str, resource_id: str = ""):
        super().__init__(
            message=f"{resource} not found" + (f": {resource_id}" if resource_id else ""),
            error_code="NOT_FOUND",
            status_code=404,
        )


class UnauthorizedError(CodeGuardException):
    def __init__(self, message: str = "Unauthorized"):
        super().__init__(message=message, error_code="UNAUTHORIZED", status_code=401)


class ForbiddenError(CodeGuardException):
    def __init__(self, message: str = "Forbidden"):
        super().__init__(message=message, error_code="FORBIDDEN", status_code=403)


class ConflictError(CodeGuardException):
    def __init__(self, message: str):
        super().__init__(message=message, error_code="CONFLICT", status_code=409)


class GitPlatformError(CodeGuardException):
    def __init__(self, platform: str, message: str):
        super().__init__(
            message=f"[{platform}] {message}",
            error_code="GIT_PLATFORM_ERROR",
            status_code=502,
        )


class AIServiceError(CodeGuardException):
    def __init__(self, message: str):
        super().__init__(message=message, error_code="AI_SERVICE_ERROR", status_code=502)
