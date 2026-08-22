CRICKET UNIVERSE V1.1 — MANAGER ONLINE ALPHA
=================================================

WHAT THIS BUILD ADDS
--------------------
This is the SAME unified project, expanded with the manager/spectator architecture:

- Host / Administrator role
- Separate private accounts for every user
- Team-manager invite codes
- Managers claim only their own team
- Manager Playing XI submission
- Captain + wicketkeeper selection
- Host alone starts the match
- Managers choose next bowler and next batter
- AI still bats, bowls and fields every ball
- Decision timeout with automatic AI fallback
- Public match code / spectator link
- Spectator role has no team-control permissions
- Live score + commentary cloud-event model
- Points table
- Tournament statistics
- Career history
- Tie + Super Over flow
- Original UI closely informed by the 25 supplied Cricket 26 screenshots
- Browser 3D cricket presentation retained

IMPORTANT ABOUT THE 25 SCREENSHOTS
----------------------------------
The screenshots were used as a visual/UX reference for:
- dotted dark sports-game backgrounds
- top profile/status bar
- large featured banner
- horizontal mode tiles
- competition designer and trophy stage
- Academy / player / team editor structure
- team-vs-team selection
- pre-match captains presentation
- match settings and pitch settings
- lineup table composition
- toss/pitch-condition overlay
- live match bottom score HUD
- player-intro stat panel
- blurred/overlay pause menu
- Manage Bowlers tactical table
- Batting Order tactical table

The actual Cricket 26 logo, artwork, photographs, player models, official kits,
official logos, fonts and proprietary game assets are NOT embedded in this package.
The package uses original CSS, code and procedural graphics.

LOCAL TEST
----------
The 3D module is loaded from a CDN, so run the folder from a local web server.

Windows example:
1. Extract the ZIP.
2. Open Command Prompt / Terminal inside the extracted folder.
3. Run:
      python -m http.server 8000
4. Open:
      http://localhost:8000

You can test different roles under:
Manager Hub > Local demo role

- Host / Administrator
- Team A Manager
- Team B Manager
- Spectator

CLOUD / REAL MULTI-USER SETUP
-----------------------------
1. Create a Supabase project.
2. Run supabase_schema.sql in Supabase SQL Editor.
3. Copy the Project URL and public anon/publishable key.
4. Put them in Account > Administrator Cloud Setup, OR in config.js.
5. Create your private user account and sign in.
6. Create a competition and open a fixture.
7. Create / Sync Online Room.
8. The host shares:
   - Team A manager code privately with Team A's manager.
   - Team B manager code privately with Team B's manager.
   - Spectator match link/code with people who only want to watch.
9. Every friend signs in using THEIR OWN email/password.
10. A manager opens Manager Hub, enters their manager code, selects/submits the XI.
11. Host waits for both XIs, then starts the match.
12. During the match, manager actions are sent through the manager_actions table.
13. If no action arrives before timeout, the AI chooses so play continues.
14. Spectators poll the cloud match state/events but cannot submit manager actions.

ONLINE DEPLOYMENT
-----------------
Upload the ENTIRE extracted folder to a static website host.
Do not upload only index.html.

A hash-based spectator link is used, for example:
  https://YOUR-SITE.example/#watch=M7K2P

That avoids requiring special server routing.

SECURITY MODEL
--------------
- Users do not share passwords.
- Manager codes grant a team assignment, not account access.
- Host credentials are never shared.
- Row Level Security limits write permissions.
- Manager decisions use a separate table; managers do NOT receive permission
  to rewrite the authoritative match state.
- Only the host can update the match engine/state.
- Spectators are read-only.

ALPHA LIMITATIONS
-----------------
This is a working architecture/prototype, not a finished Cricket 26-quality commercial game.
The 3D players remain procedural low-poly humanoids. The next major graphics phase is:
rigged character models, cricket-specific bowling/batting/fielding animation sets,
broadcast replays, improved stadiums/crowds, and higher-fidelity physics/presentation.
