# Trips: a shared trip planner

A Wanderlog-style planner for all your trips. It lives in the same GitHub repo and Firebase project as Europe 2029.

- **Home:** all your trips as cards. Start a new one, or bring Europe 2029 in.
- **Itinerary:** day by day. Search to add places to a day, drag to reorder or move between days, set times, and see walking or travel time between stops. **Optimize route** puts a day's stops in the shortest order (with Undo), and **Directions** opens the whole day in Google Maps. Flights, trains, check-ins and reservations appear on the right day automatically.
- **Places:** your saved places, with photos, hearts, filters and a "schedule it" dropdown.
- **Bookings:** flights, trains, stays, rental cars, reservations and tickets, with times, layovers, confirmation numbers (tap to copy) and costs.
- **Budget:** a budget against what's spent and what's planned, by category, plus **Who owes whom** with Settle up, like Splitwise.
- **Overview:** dates, destination, currency, cover photo, people, notes and a to-do list.
- **Map:** a real street map (OpenStreetMap) that follows what you're looking at. Tap a day to see just that day's route.
- **Sharing:** each trip has its own people. Invite them by Gmail from **Share**; they only see the trips they're invited to.

---

## Setup (about 5 minutes)

### 1. Upload the `trips` folder to your repo
In your GitHub repo (the one with the Europe 2029 site), click **Add file → Upload files** and drag in the whole **`trips` folder**.
Keep it as a folder; GitHub keeps the folder structure when you drag a folder in Chrome or Edge. Then click **Commit changes**.

It reuses the `config.js` at the top of the repo, so there's nothing to fill in.

### 2. Replace the database rules
In Firebase, go to **Firestore Database → Rules**, replace everything with the contents of **`firestore.rules`** (included next to this README), then:
- In `europeGuest()`, put the same two emails you had before (so the old Europe site keeps working).
- In `tripCreator()`, put the emails of people allowed to **create** new trips (probably just you). Anyone you invite to a trip can still see and edit that trip.
- Use lowercase emails, then click **Publish**.

### 3. Open it
Go to `https://<your-username>.github.io/<repo-name>/trips/`, sign in, and click **Import Europe 2029**.
Then open the trip, click **Share**, and invite your friend's Gmail. Send her the link.

Sign-in already works, because it's the same address as the Europe site.

---

## Good to know
- **What the import copies:** the route cities, spots (with photos), flights and trains (times, layovers, confirmations), stays, other costs, day notes, day photos and to-dos. Costs that weren't paid yet come in as **estimates**. Savings and packing lists aren't copied. The old Europe 2029 site keeps working as it is.
- **Offline:** once you've opened a trip, it opens offline (add it to your home screen) and edits sync when you're back online. Map tiles and place search need a connection.
- **Maps and photos:** map tiles come from CARTO and OpenStreetMap, place search from Photon (OpenStreetMap data), and photos from Wikipedia, Wikimedia Commons and, if you've added a key to `config.js`, Unsplash. All of these are free for personal use and credited in the app.
- **Travel times** are estimates from straight-line distance. Use **Directions** for real routes and transit.
- **After uploading new versions of these files,** change `VERSION` in `trips/sw.js` so phones pick up the update.
