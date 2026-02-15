# MedSek (TreeHacks 2026)

AI-powered medical assistant!

This was made for TreeHacks 2026.

## Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/propadiene-1/TreeHacks-2026.git
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
    + Create a file called `.env` file in the root directory:
    ```env
    # Server Configuration
    PORT=4000
    ```

4. **Set up API keys**

   **OpenAI API Key:**
   - Visit [OpenAI](https://openai.com) and get your API key
   - Paste your API key (starts with "sk-") as OPENAI_API_KEY=[YOUR API KEY]

5. **Run the app**
    ```bash
    npm start
    ```

## Tech Stack

- **Backend**: Node.js, Express
- **Voice Processing**: Twilio Voice API with real-time speech-to-text
- **Natural Language**: OpenAI GPT-4o (conversational AI + function calling)
- **Vector DB**: ChromaDB (semantic search)
- **Scheduling**: node-cron with adaptive recurrence logic
- **Analytics**: Custom pain recalibration detection
- **Frontend**: HTML, JavaScript, CSS

## Project Structure

```
TreeHacks-2026/
├── public/                 # frontend
│   ├── index.html        # main page
│   │   dashboard.html        # user data
│   │   script.js           # frontend functions
|   |   style.css           # UI
├── package.json            # dependencies
|   openai-calls.js         #api calls
|   server.js               #backend logic
├── .env                   # environment variablees
└── README.md
```
## Authors
- Isita
- Ashita
- Nishka
- Aileen