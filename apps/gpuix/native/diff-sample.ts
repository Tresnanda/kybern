export const sample = `diff --git a/src/greeting.ts b/src/greeting.ts
--- a/src/greeting.ts
+++ b/src/greeting.ts
@@ -1,5 +1,6 @@
 // Greeting factory
-export const greeting = "Hello";
+export const greeting = "Welcome";
+const locale = "en-US";
 export function greet(name: string) {
-  return greeting + name;
+  return greeting + ", " + name;
 }
@@ -24,2 +25,2 @@
-const previous = false;
+const current = true;
 export const long = "${'Long line 😀é '.repeat(16)}END_OF_LONG_LINE";
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Example
-Old instructions
+Updated instructions
+Run the example.
diff --git a/src/added.ts b/src/added.ts
new file mode 100644
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,2 @@
+export const enabled = true;
+export default enabled;
diff --git a/obsolete.txt b/obsolete.txt
deleted file mode 100644
--- a/obsolete.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-legacy setting`;
export const largeSample = 'diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,30000 +1,30000 @@\n' + Array.from({length:30000},(_,i)=>' '+`const line${i} = ${i};`).join('\n');
