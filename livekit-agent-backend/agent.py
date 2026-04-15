import logging
import os
import asyncio
from datetime import datetime
from dotenv import load_dotenv

from livekit import rtc
from livekit.agents import (
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
    voice,
    llm,
)
from livekit.plugins import openai, deepgram, silero

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("aria-v8-agent")

# Silence noisy logs
logging.getLogger("livekit.agents.inference").setLevel(logging.CRITICAL)
logging.getLogger("livekit.agents").setLevel(logging.WARNING)
logging.getLogger("livekit").setLevel(logging.WARNING)
logging.getLogger("asyncio").setLevel(logging.WARNING)

# ── LOGGING UTILS ─────────────────────────────────────────────────────────────

LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
if not os.path.exists(LOG_DIR):
    os.makedirs(LOG_DIR, exist_ok=True)

def log_to_file(filename: str, content: str):
    try:
        path = os.path.join(LOG_DIR, filename)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    except Exception as e:
        logger.error(f"Failed to write log {filename}: {e}")

# ─────────────────────────────────────────────────────────────────────────────
# ARIA v8 — Speaker-First Agent
# ─────────────────────────────────────────────────────────────────────────────

FALLBACK_INSTRUCTIONS = (
    "You are Aria, a senior technical interviewer. "
    "Wait for context packets from the frontend."
)


async def entrypoint(ctx: JobContext):
    logger.info(f"--- ARIA v8 JOB RECEIVED: room={ctx.room.name} ---")

    try:
        await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    except Exception as e:
        logger.error(f"Connection failed: {e}")
        return

    oai_key = os.getenv("OPENAI_API_KEY", "").strip()
    dg_key  = os.getenv("DEEPGRAM_API_KEY", "").strip()

    if not oai_key or not dg_key:
        logger.error("Missing API keys (OpenAI or Deepgram)")
        return

    # ── State ──────────────────────────────────────────────────────────────
    last_sync_id = None
    current_instructions = FALLBACK_INSTRUCTIONS
    has_greeted = False

    # Wait for the first participant to join if not already present
    while not ctx.room.remote_participants:
        await asyncio.sleep(0.1)

    participant = list(ctx.room.remote_participants.values())[0]
    voice_attr = participant.attributes.get("voice", "thalia")
    model_name = f"aura-2-{voice_attr}-en"
    logger.info(f"🎙 VOICE SYNC: {voice_attr} ({model_name})")

    agent = voice.Agent(
            instructions=FALLBACK_INSTRUCTIONS,
            stt=deepgram.STT(api_key=dg_key), 
            llm=openai.LLM(model="gpt-4o-mini", api_key=oai_key),
            tts=deepgram.TTS(api_key=dg_key, model=model_name),
            vad=silero.VAD.load(
                min_silence_duration=2.5,
                activation_threshold=0.5,
            ),
        )

    session = voice.AgentSession()

    # ── ATTRIBUTE INTERCEPTOR ──────────────────────────────────────────────
    
    def apply_instructions(instructions: str):
        if not agent.chat_ctx:
            logger.warning("⚠️ chat_ctx not initialized yet")
            return
            
        messages = agent.chat_ctx.messages()
        if not messages:
            agent.chat_ctx.append(role="system", text=instructions)
            logger.info("🆕 System message added to empty context")
        else:
            # Find first system message or replace index 0
            found = False
            for msg in messages:
                if msg.role == "system":
                    msg.content = instructions
                    found = True
                    break
            
            if found:
                logger.info("✅ System prompt updated in-place")
            else:
                # If no system message found, insert at top
                messages.insert(0, llm.ChatMessage(role="system", content=instructions))
                logger.info("⬆️ System prompt inserted at top")

    def handle_instruction_update(participant: rtc.Participant):
        nonlocal last_sync_id, current_instructions, has_greeted
        
        attrs = participant.attributes
        sync_id   = attrs.get("sync_id", "")
        new_instr = attrs.get("instructions", "").strip()
        do_reset  = attrs.get("reset_chat", "false").lower() == "true"
        is_start  = attrs.get("is_start", "false").lower() == "true"

        if do_reset:
            logger.info("🚨 RESET SIGNAL RECEIVED — Purging chat context...")
            if agent.chat_ctx:
                # Clear all messages
                agent.chat_ctx.messages().clear()
                # Restore system prompt
                apply_instructions(new_instr or current_instructions)
                logger.info("漫 Context purged. Re-initialized with instructions.")
                has_greeted = False
            return

        if not new_instr:
            return

        if sync_id and sync_id == last_sync_id:
            return

        last_sync_id = sync_id
        current_instructions = new_instr
        
        # Log to file for visibility (APPEND MODE)
        with open(os.path.join(LOG_DIR, "prompt_history.md"), "a", encoding="utf-8") as f:
            f.write(f"\n\n--- [SYNC_ID: {sync_id}] [{datetime.now().strftime('%H:%M:%S')}] ---\n\n{new_instr}\n")
        
        logger.info(f"📥 PROMPT SYNC [id={sync_id}]: {new_instr[:100]}...")
        apply_instructions(new_instr)

        if is_start and not has_greeted:
            logger.info("🚀 Triggering initial AI greeting...")
            has_greeted = True
            session.generate_reply()

    @ctx.room.on("participant_attributes_changed")
    def on_attributes_changed(changed_attributes: dict, participant: rtc.Participant):
        handle_instruction_update(participant)



    # ── LOGGING HOOKS ──────────────────────────────────────────────────────
    @session.on("agent_speech_committed")
    def on_aria_spoke(msg):
        text = getattr(msg, "content", None) or str(msg)
        if isinstance(text, list): text = " ".join(str(p) for p in text)
        logger.info(f"ARIA  >> {str(text)[:100]}...")
        
        # Log current history to file
        history = "\n".join([f"{m.role}: {m.content}" for m in agent.chat_ctx.messages()])
        log_to_file("last_run_history.md", history)

    @session.on("user_speech_committed")
    def on_user_spoke(msg):
        text = getattr(msg, "content", None) or str(msg)
        if isinstance(text, list): text = " ".join(str(p) for p in text)
        logger.info(f"USER  >> {str(text)[:100]}...")

    # ── START ──────────────────────────────────────────────────────────────
    await session.start(agent, room=ctx.room)
    logger.info("✅ ARIA v8 online — listening for context packets...")

    # Initial check
    for p in ctx.room.remote_participants.values():
        handle_instruction_update(p)

    await asyncio.sleep(float("inf"))


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))