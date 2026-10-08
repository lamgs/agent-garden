# Team defaults

- Every handler takes the tenant from `req.auth.tenantId`; never from the body or query.
