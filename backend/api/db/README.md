So there are some complicated ideas going on here in the db/ folder.  Here's some help for you:

1.) A migrations folder is a directory in a software project that stores version-controlled scripts.  Typically these are SQL or code-based files that are used to manage, evolve, and update a database schema over time.  It is the source of "truth" for your data model.
2.) The engine.py is a wrapper for the SQL database for my API to access.