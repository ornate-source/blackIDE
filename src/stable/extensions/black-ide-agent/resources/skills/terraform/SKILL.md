---
name: terraform
description: Terraform module structure, state discipline and plan review
roles: [devops, architect]
stacks: [terraform]
triggers: [terraform, .tf, resource, module, terraform plan, state, provider]
priority: 8
---
# Terraform

## Conventions
- Remote state with locking (S3 + DynamoDB, or Terraform Cloud). Local state on a shared project is a race.
- One state per environment; a workspace or a directory, but never one state for prod and dev.
- Modules take variables and return outputs — no hardcoded account ids or regions inside a module.
- Pin the provider *and* Terraform versions in `required_providers`; providers make breaking changes in minor releases.
- Review `plan` output as the artifact it is. `apply` without reading a plan is the whole risk of this tool.

## Commands
- `terraform init` · `terraform fmt -recursive` · `terraform validate` · `terraform plan -out=tfplan` · `terraform apply tfplan`

## Pitfalls
- `terraform destroy` on the wrong workspace. Check `terraform workspace show` first.
- Manual console changes drift from state; `import` them or remove them, do not ignore them.
- Secrets in `.tfvars` committed to the repo — state itself holds them in plaintext, so protect the backend.
