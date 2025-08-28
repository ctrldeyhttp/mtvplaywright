import tkinter as tk

root = tk.Tk()

root.geometry("800x400")
root.title("MEOW")

label = tk.Label(root, text="Do You Like Me?", font=('Papyrus', 20))
label.pack(padx=20, pady=100)

buttonFrame = tk.Frame(root)
buttonFrame.columnconfigure(0, weight=1)
buttonFrame.columnconfigure(1, weight=1)

def yes_click():
    label.config(text="YAY")


def no_click():
    current_font_info = btn1.cget("font")
    current_font_size = int(current_font_info.split()[1])
    new_font_size = current_font_size + 2
    btn1.config(font=("Papyrus", new_font_size))

btn1 = tk.Button(buttonFrame, text="Yes", font=("Papyrus", 16), command=yes_click)
btn1.grid(row=0, column=0, sticky=tk.W+tk.E)

btn2 = tk.Button(buttonFrame, text="No", font=("Papyrus", 16), command=no_click)
btn2.grid(row=0, column=1, sticky=tk.W+tk.E)

buttonFrame.pack(fill='x')

root.mainloop()