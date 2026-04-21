Generator Service Request Bot
A specialized Telegram bot designed to streamline and automate service request management for power generators. This project utilizes a serverless architecture for high scalability and low latency.

🚀 Features
Request Management: Users can submit and track generator service requests directly through Telegram.

Automated Workflow: Handles incoming requests via webhooks and processes them using Supabase Edge Functions.

Persistent Storage: All request data and logs are securely stored in a Supabase PostgreSQL database.

Real-time Notifications: Instant alerts for technicians or admins when new service logs are generated.

🛠️ Tech Stack
Runtime: Deno

Backend: Supabase Edge Functions

Database: PostgreSQL (via Supabase)

Language: TypeScript

API: Telegram Bot API

📁 Project Structure
Plaintext
├── supabase
│   ├── functions
│   │   └── telegram-bot
│   │       └── index.ts    # Main entry point for the Edge Function
│   └── config.toml         # Supabase configuration
├── .env.example            # Template for environment variables
└── README.md
⚙️ Setup & Installation
1. Prerequisites
Supabase CLI installed and linked to your project.

A Telegram Bot token from @BotFather.

2. Environment Variables
Create a .env file in your project root (or set them in the Supabase Dashboard):

Code snippet
TELEGRAM_BOT_TOKEN=your_bot_token_here
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
3. Deploying Edge Functions
Initialize and deploy the function to Supabase:

Bash
# Login to Supabase
supabase login

# Deploy the function
supabase functions deploy telegram-bot --no-verify-jwt
4. Setting the Webhook
Once deployed, set your Telegram webhook to point to your Supabase function URL:

Bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=<YOUR_FUNCTION_URL>"
📋 Usage
Open the bot in Telegram.

Use /start to initialize the interface.

Follow the prompts to submit a service request or check the status of a generator unit.

🛡️ Security
This bot is designed with security in mind, utilizing Supabase service roles for database interactions and environment variable masking for sensitive tokens.
