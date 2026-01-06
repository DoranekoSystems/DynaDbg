use std::alloc::{GlobalAlloc, Layout, System};
use std::backtrace::Backtrace;
use std::panic;

#[global_allocator]
static A: MyAllocator = MyAllocator;

struct MyAllocator;

unsafe impl GlobalAlloc for MyAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if ptr.is_null() {
            handle_alloc_error(layout)
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
}

fn handle_alloc_error(layout: Layout) -> ! {
    let backtrace = Backtrace::force_capture();
    eprintln!(
        "memory allocation of {} bytes failed\nBacktrace:\n{:?}",
        layout.size(),
        backtrace
    );
    panic!("memory allocation of {} bytes failed", layout.size());
}
