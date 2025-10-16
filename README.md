# Finance Agent

Event-driven finance automation for Workday using AWS Lambda, EventBridge, and TypeScript.

## Architecture

```
EventBridge Schedule → WqlToEventFunction → EventBridge → Action Lambdas
```

**Pattern:** Schedule triggers WQL queries → Results published to EventBridge → Routed to action handlers

```
src/
├── wqlToEvent.ts         # Executes WQL queries, publishes to EventBridge
├── actions/              # Action handlers (one per action type)
│   └── enrich_invoice.ts # Example: invoice enrichment
├── lib/
│   └── workday.ts        # Workday API utilities
└── globals.d.ts          # Type declarations for external packages
```

## Quick Start

```bash
npm install
npm run build
sam build && sam deploy --guided
```

## Core Concepts

### 1. Schedules Define Queries + Actions

In `template.yml`, schedules specify what to query and which action to trigger:

```yaml
WqlToEventFunction:
  Events:
    EnrichInvoicesSchedule:
      Schedule: rate(1 hour)
      Input:
        action: enrich_invoice        # Which action handler to invoke
        query: SELECT ... FROM ...    # Workday WQL query
```

### 2. EventBridge Routes by Action

Each action handler subscribes to its action name:

```yaml
EnrichInvoiceAction:
  Events:
    Trigger:
      Type: EventBridgeRule
      Pattern:
        detail:
          action: [enrich_invoice]    # Only receives matching events
```

### 3. Action Handlers Process Results

Each WQL query result becomes an individual EventBridge event processed by the matching action handler.

## Adding New Actions

**Step 1:** Create handler by copying existing action
```bash
cp src/actions/enrich_invoice.ts src/actions/process_payment.ts
```

**Step 2:** Add Lambda + EventBridge rule to `template.yml`
```yaml
  # Action: process_payment
  ProcessPaymentAction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: dist/actions/process_payment.handler
      Role: !GetAtt FinanceAgentLambdaRole.Arn
      Events:
        Trigger:
          Type: EventBridgeRule
          Properties:
            EventBusName: !Ref FinanceAgentEventBus
            Pattern:
              detail:
                action: [process_payment]
```

**Step 3:** Add schedule to trigger it (optional)
```yaml
WqlToEventFunction:
  Events:
    ProcessPaymentSchedule:
      Schedule: rate(30 minutes)
      Input:
        action: process_payment
        query: SELECT * FROM payments WHERE status = "Pending"
```

That's it! Deploy and your new action will process WQL results on schedule.

## Environment Setup

Configuration is stored in AWS Systems Manager Parameter Store. Before deploying, create these SSM parameters:

```bash
# Workday Configuration
aws ssm put-parameter --name /finance-agent/workday-api-url --value "https://wd2-impl-services1.workday.com" --type String
aws ssm put-parameter --name /finance-agent/workday-tenant --value "your-tenant" --type String
aws ssm put-parameter --name /finance-agent/workday-user --value "ISU_USERNAME" --type String
aws ssm put-parameter --name /finance-agent/workday-password --value "password" --type SecureString

# API Keys
aws ssm put-parameter --name /finance-agent/openai-api-key --value "sk-..." --type SecureString
```

**Note:** `LOG_LEVEL` is set via CloudFormation parameter (DEBUG for dev, WARN for prod) during deployment.

