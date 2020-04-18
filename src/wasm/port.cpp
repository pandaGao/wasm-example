#ifndef EM_PORT_API
  #if defined(__EMSCRIPTEN__)
    #include <emscripten.h>
    #if defined(__cplusplus)
      #define EM_PORT_API(rettype) extern "C" rettype EMSCRIPTEN_KEEPALIVE
    #else
      #define EM_PORT_API(rettype) rettype EMSCRIPTEN_KEEPALIVE
    #endif
  #else
    #if defined(__cplusplus)
      #define EM_PORT_API(rettype) extern "C" rettype
    #else
      #define EM_PORT_API(rettype) rettype
    #endif
  #endif
#endif

EM_PORT_API(const char*) hello_world() {
  EM_ASM(
    console.log("hello world");
  );
  return "hello world";
}

EM_PORT_API(int) benchMarkAdd(int a, int b) {
  int c;
  for (int i = 0; i < 10000000; i++) {
    c = a + b;
  }
  return c;
}

EMSCRIPTEN_KEEPALIVE int addInt(int a, int b) {
  return a + b;
}

EM_PORT_API(int) sumInt(int *arr, int length) {
  int sum = 0;
  for (int i=0; i < length; i++) {
    sum += arr[i];
  }
  return sum;
}

EM_PORT_API(void) doubleIntArray(int *arr, int *res, int length) {
  for (int i=0; i < length; i++) {
    res[i] = arr[i] * 2;
  }
}