import logging
import os
import asyncio
from dotenv import load_dotenv

from livekit import rtc
from livekit.agents import (
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
    voice,
    llm
)
from livekit.plugins import openai, deepgram

load_dotenv()

async def inspect():
    # Create a mutable context
    chat_ctx = llm.ChatContext()
    chat_ctx.append(role="system", text="initial instructions")
    
    agent = voice.Agent(
        chat_ctx=chat_ctx,
        stt=deepgram.STT(),
        llm=openai.LLM(),
        tts=deepgram.TTS(),
    )
    
    print(f"Agent type: {type(agent)}")
    print(f"agent.chat_ctx type: {type(agent.chat_ctx)}")
    
    # Check if messages is a method
    messages_attr = agent.chat_ctx.messages
    print(f"agent.chat_ctx.messages type: {type(messages_attr)}")
    
    if callable(messages_attr):
        messages = messages_attr() # Call it
        print(f"messages() type: {type(messages)}")
        print(f"First message: {messages[0].content}")
        
        try:
            messages[0].content = "updated instructions"
            print(f"Success: Modified messages[0].content")
            print(f"Re-fetching: {agent.chat_ctx.messages()[0].content}")
        except Exception as e:
            print(f"Failure: Could not modify messages[0].content: {e}")
    else:
        # If it's a property/list
        print(f"First message (list): {agent.chat_ctx.messages[0].content}")
        agent.chat_ctx.messages[0].content = "updated instructions"
        print(f"After update: {agent.chat_ctx.messages[0].content}")

if __name__ == "__main__":
    asyncio.run(inspect())
