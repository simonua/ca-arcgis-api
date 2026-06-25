# Infrastructure Boundary

Production infrastructure will be authored only in Bicep after deployment is authorized. The
baseline is one Azure Container App in a Consumption environment, exactly one replica, managed
external HTTPS ingress, and the smallest approved observability profile.

Do not add imperative production deployment scripts, checked-in resource identifiers, secrets, or
speculative services. Follow the architecture and cost boundaries in the integration plan.
