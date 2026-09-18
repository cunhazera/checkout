/**
 * Fails early, and in English, on a Node version this project cannot run on.
 *
 * The floor is real: the API's scripts pass --env-file-if-exists, which Node
 * only understands from 22.9. Without this check that surfaces as a bad-option
 * error from a flag the reader never typed, which looks like a broken project
 * rather than a wrong Node.
 *
 * Deliberately not `engine-strict` in .npmrc: that makes npm refuse the install
 * outright, and it applies to every transitive dependency's engines range too,
 * so an unrelated package can block a perfectly fine machine. A warning at
 * install plus a clear message at the moment it matters is the safer trade.
 *
 * Kept to syntax old Node parses, so it can report the problem instead of
 * dying of it.
 */

var MIN = [22, 9];

var current = process.versions.node.split('.').map(Number);
var ok = current[0] > MIN[0] || (current[0] === MIN[0] && current[1] >= MIN[1]);

if (!ok) {
  var want = MIN.join('.');
  process.stderr.write(
    '\n  This project needs Node ' +
      want +
      ' or newer. You are on ' +
      process.versions.node +
      '.\n\n' +
      '  The API is started with --env-file-if-exists, which Node added in ' +
      want +
      '.\n' +
      '  Install a newer Node (nvm install 22 && nvm use 22) and run this again.\n\n',
  );
  process.exit(1);
}
