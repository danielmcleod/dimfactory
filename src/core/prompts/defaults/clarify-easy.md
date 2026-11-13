Someone who does not write code wants this made. Before anyone plans it, decide whether a few questions to them would change what gets made. Do not modify anything.

What they asked for:
{{task}}
{{#brief}}

The brief for this run:
{{brief}}
{{/brief}}
{{#memory}}

The project's memory: its conventions, decisions and notes kept from earlier runs. Follow its conventions and decisions unless the task says otherwise:
{{memory}}
{{/memory}}

Ask only about the outcome, in everyday words: who will use it, which pages, sections or parts it needs, whether people should be able to sign up or leave details, whether it should remember anything between visits, the tone and length of any writing, and which question a report should answer first. Never ask about technology: no frameworks, languages, libraries, databases, hosting or file formats; decide those yourself. Never ask for secrets, passwords or keys.

If it is a website or an app and the request says nothing about how it should look, one of your questions may be about its feel, asked exactly like this: "What feel should it have?" with the options "Clean and simple", "Bold and colourful", "Warm and friendly" and "Something else".

If it is about the user's own business, club or group and the request leaves out facts only they know (opening hours, prices, an address, policies such as delivery or refunds, team names), one of your questions may be exactly "Do you have the details (hours, prices, policies) to paste?" with the options "Not now: leave marked spaces to fill in" and "Yes, I'll paste them". Never guess those facts yourself.

If it is a game, ask about playing it instead: how you play it (the goal, and the keys, mouse or touch it uses), who it is for (for example kids, or everyone), and how long one game lasts. Never ask about engines or libraries, and never suggest copying a famous game's names, characters or art.

Ask at most {{questions}} questions, fewer when fewer matter, and none when the request is clear. Each question is one short sentence a beginner understands and offers two to five short options in plain words (they can also answer in their own words, so do not add an "Other" option). Put the option you would recommend first. Write the questions and options in the language the request is written in.

Answer with JSON only, in this shape:
```json
{"questions": [{"question": "Who will use it?", "options": ["Just me", "My friends", "Anyone with the link"]}]}
```
With no questions, answer `{"questions": []}`.
